// The six Edge Function handlers, built from injected dependencies so they can be
// exercised end to end in tests with fake stores and a fake exchange.

import {
  ApiError,
  type AuthDeps,
  authenticate,
  jsonResponse,
  readBytesLimited,
  readJsonObject,
  route,
  sha256Hex,
  WindowLimiter,
} from "./api.ts";
import { BybitError } from "./bybit.ts";
import { GroqError, MAX_AUDIO_BYTES, transcribe } from "./groq.ts";
import { parseVoiceCommand } from "./voice.ts";
import {
  confirm,
  type Ctx,
  getSnapshot,
  pairClaim,
  pairStart,
  propose,
  setKillSwitch,
  setLimit,
} from "./service.ts";

export interface Deps extends Ctx, AuthDeps {
  groqKey: () => string | undefined;
  region: () => string | undefined;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function makeHandlers(deps: Deps) {
  const transcribeLimiter = new WindowLimiter(10, 60_000);
  const pairStartLimiter = new WindowLimiter(20, 60_000);
  const authed = (req: Request) => authenticate(req, deps);

  return {
    /** Public. Wakes the database and checks the exchange, so a scheduled ping keeps both warm. */
    health: route(["GET"], async (_req) => {
      let db: "ok" | "error" = "ok";
      try {
        await deps.store.ping();
      } catch {
        db = "error";
      }
      let exchange: string = "ok";
      try {
        await deps.exchange().serverTimeMs();
      } catch (e) {
        exchange = e instanceof BybitError ? e.kind : e instanceof ApiError ? e.code : "error";
      }
      return jsonResponse({
        ok: db === "ok" && exchange === "ok",
        time: new Date(deps.now()).toISOString(),
        region: deps.region() ?? null,
        db,
        exchange,
        voice: deps.groqKey() ? "configured" : "not_configured",
      });
    }),

    pair: route(["POST"], async (req) => {
      const body = await readJsonObject(req);
      switch (body.action) {
        case "start": {
          const wait = pairStartLimiter.check("global", deps.now());
          if (wait > 0) throw new ApiError(429, "rate_limited", "Too many pairing requests.", { retryAfterMs: wait });
          const r = await pairStart(deps.store, sha256Hex);
          return jsonResponse({ ok: true, ...r });
        }
        case "poll": {
          const token = req.headers.get("x-device-token") ?? "";
          if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new ApiError(401, "unauthorized", "Invalid device token.");
          const r = await deps.store.redeemPairing(await sha256Hex(token));
          return jsonResponse({ ok: true, status: r.status, ...(r.expires_at ? { expiresAt: r.expires_at } : {}) });
        }
        case "claim": {
          const caller = await authed(req);
          return jsonResponse({ ok: true, ...(await pairClaim(deps.store, caller, body.code)) });
        }
        default:
          throw new ApiError(400, "bad_request", "action must be start, poll or claim.");
      }
    }),

    limits: route(["GET", "POST"], async (req) => {
      const caller = await authed(req);
      if (req.method === "GET") {
        const l = await deps.store.getLimits(caller.userId);
        return jsonResponse({ ok: true, limit: l.daily_limit === null ? null : Number(l.daily_limit), killSwitch: l.kill_switch });
      }
      const body = await readJsonObject(req);
      if ("limit" in body) return jsonResponse({ ok: true, ...(await setLimit(deps, caller, body.limit)) });
      if ("killSwitch" in body) return jsonResponse({ ok: true, ...(await setKillSwitch(deps, caller, body.killSwitch)) });
      throw new ApiError(400, "bad_request", "Send limit or killSwitch.");
    }),

    positions: route(["GET"], async (req) => {
      const caller = await authed(req);
      return jsonResponse({ ok: true, ...(await getSnapshot(deps, caller)) });
    }),

    act: route(["POST"], async (req) => {
      const caller = await authed(req);
      const body = await readJsonObject(req);
      if (body.action === "propose") {
        return jsonResponse({ ok: true, ...(await propose(deps, caller, body.kind)) });
      }
      if (body.action === "confirm") {
        return jsonResponse({ ok: true, ...(await confirm(deps, caller, body.proposalId, body.kind)) });
      }
      throw new ApiError(400, "bad_request", "action must be propose or confirm.");
    }),

    /** Audio in, transcript and parsed command out. Never writes anything itself. */
    transcribe: route(["POST"], async (req) => {
      const caller = await authed(req);
      const wait = transcribeLimiter.check(caller.userId, deps.now());
      if (wait > 0) throw new ApiError(429, "rate_limited", "Too many voice requests.", { retryAfterMs: wait });
      const audio = await readBytesLimited(req, MAX_AUDIO_BYTES);
      try {
        const text = await transcribe(audio, req.headers.get("content-type") ?? "", {
          apiKey: deps.groqKey(),
          fetchFn: deps.fetchFn,
          sleep: deps.sleep,
        });
        return jsonResponse({ ok: true, text, command: parseVoiceCommand(text) });
      } catch (e) {
        if (e instanceof GroqError) {
          const map = {
            not_configured: [503, "voice_unavailable"],
            bad_audio: [400, "bad_audio"],
            rate_limited: [429, "voice_rate_limited"],
            auth: [503, "voice_unavailable"],
            unavailable: [503, "voice_unavailable"],
          } as const;
          const [status, code] = map[e.kind];
          throw new ApiError(status, code, "Voice is unavailable right now. Use the swipe controls.", {
            ...(e.retryAfterSeconds !== null ? { retryAfterMs: e.retryAfterSeconds * 1000 } : {}),
          });
        }
        throw e;
      }
    }),
  };
}
