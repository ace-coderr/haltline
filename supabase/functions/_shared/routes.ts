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
import { ExchangeError } from "./exchange.ts";
import { INSTRUMENTS, MODEL } from "./instruments.ts";
import type { PaperExchange } from "./paper.ts";
import { type PriceFeed, quoteAge } from "./prices.ts";
import { GroqError, MAX_AUDIO_BYTES, transcribe } from "./groq.ts";
import { parseVoiceCommand } from "./voice.ts";
import { utcDayStart } from "./limits.ts";
import {
  confirm,
  type Ctx,
  exchangeFailure,
  getSnapshot,
  pairClaim,
  pairStart,
  propose,
  setKillSwitch,
  setLimit,
} from "./service.ts";

export interface Deps extends Ctx, AuthDeps {
  paper: PaperExchange["panel"];
  prices: PriceFeed;
  groqKey: () => string | undefined;
  region: () => string | undefined;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function makeHandlers(deps: Deps) {
  const transcribeLimiter = new WindowLimiter(10, 60_000);
  const pairStartLimiter = new WindowLimiter(20, 60_000);
  const pricesLimiter = new WindowLimiter(120, 60_000);
  const paperLimiter = new WindowLimiter(30, 60_000);
  const authed = (req: Request) => authenticate(req, deps);

  return {
    /** Public. Wakes the database and checks the exchange, so a scheduled ping keeps both warm. */
    health: route(["GET"], async (_req) => {
      let db: "ok" | "error" = "ok";
      let dbCode: string | undefined;
      try {
        await deps.store.ping();
      } catch (e) {
        db = "error";
        const c = (e as { code?: unknown }).code;
        dbCode = e instanceof ApiError ? e.code : typeof c === "string" && /^[A-Za-z0-9_]{1,16}$/.test(c) ? c : "unknown";
      }
      let prices: string = "ok";
      let priceAgeMs: number | null = null;
      try {
        priceAgeMs = (await deps.exchange().health()).priceAgeMs;
      } catch (e) {
        prices = e instanceof ExchangeError ? e.kind : e instanceof ApiError ? e.code : "error";
      }
      return jsonResponse({
        ok: db === "ok" && prices === "ok",
        time: new Date(deps.now()).toISOString(),
        region: deps.region() ?? null,
        db,
        ...(dbCode ? { dbCode } : {}),
        priceSource: { name: "Bitstamp public ticker", status: prices, ageMs: priceAgeMs },
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

    /** Public, cached live prices for the website. Also keeps the price cache warm. */
    prices: route(["GET"], async (_req) => {
      const wait = pricesLimiter.check("global", deps.now());
      if (wait > 0) throw new ApiError(429, "rate_limited", "Too many requests.", { retryAfterMs: wait });
      let quotes;
      try {
        quotes = await deps.prices.getQuotes();
      } catch (e) {
        throw exchangeFailure(e);
      }
      const now = deps.now();
      return jsonResponse({
        ok: true,
        source: MODEL.priceSource,
        quotes: INSTRUMENTS.map((i) => {
          const q = quotes.get(i.symbol)!;
          return { symbol: i.symbol, base: i.base, bid: q.bid, ask: q.ask, last: q.last, ageMs: quoteAge(q, now) };
        }),
      });
    }),

    /** The paper account: view it, open and close positions, reset. Writes are website-only. */
    paper: route(["GET", "POST"], async (req) => {
      const caller = await authed(req);
      if (req.method === "GET") {
        try {
          return jsonResponse({ ok: true, ...(await deps.paper.accountView(caller.userId, utcDayStart(deps.now()))) });
        } catch (e) {
          throw exchangeFailure(e);
        }
      }
      if (caller.via !== "user") throw new ApiError(403, "forbidden", "Paper trades are placed from the website.");
      const wait = paperLimiter.check(caller.userId, deps.now());
      if (wait > 0) throw new ApiError(429, "rate_limited", "Slow down.", { retryAfterMs: wait });
      const body = await readJsonObject(req);
      const clientId = typeof body.clientId === "string" && /^[A-Za-z0-9_-]{8,32}$/.test(body.clientId) ? `web-${body.clientId}` : null;
      try {
        if (body.action === "open") {
          if (!clientId) throw new ApiError(400, "bad_request", "clientId (8-32 letters, digits, - or _) is required.");
          return jsonResponse({ ok: true, ...(await deps.paper.open(caller.userId, body.symbol, body.side, body.size, clientId)) });
        }
        if (body.action === "close") {
          if (!clientId) throw new ApiError(400, "bad_request", "clientId (8-32 letters, digits, - or _) is required.");
          return jsonResponse({ ok: true, ...(await deps.paper.close(caller.userId, body.symbol, body.size, clientId)) });
        }
        if (body.action === "reset") {
          await deps.paper.reset(caller.userId);
          return jsonResponse({ ok: true, reset: true });
        }
      } catch (e) {
        throw exchangeFailure(e);
      }
      throw new ApiError(400, "bad_request", "action must be open, close or reset.");
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
