// Deno runtime wiring: real Supabase client, real exchange client, real clock.
// Kept out of the Node typecheck/tests (it uses Deno globals and an npm: import); it is
// type-checked with `deno check` instead. All logic lives in the injected-dependency modules.
import { createClient } from "npm:@supabase/supabase-js@2";
import { ApiError } from "./api.ts";
import { createBybitClient } from "./bybit.ts";
import { TestnetGuardError } from "./guard.ts";
import { makeHandlers } from "./routes.ts";
import type { Exchange, Store } from "./service.ts";

const env = (name: string): string | undefined => {
  const v = Deno.env.get(name);
  return v && v.length > 0 ? v : undefined;
};

function adminClient() {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new ApiError(503, "backend_not_configured", "Backend is not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

let admin: ReturnType<typeof adminClient> | null = null;
const db = () => (admin ??= adminClient());

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`database: ${res.error.message}`);
  return res.data;
}

const store: Store = {
  async ping() {
    check(await db().from("limits").select("user_id").limit(1));
  },
  async getLimits(userId) {
    const row = check(await db().from("limits").select("daily_limit,kill_switch,last_action_at").eq("user_id", userId).maybeSingle());
    return row ?? { daily_limit: null, kill_switch: false, last_action_at: null };
  },
  async setLimit(userId, amount) {
    check(await db().from("limits").upsert({ user_id: userId, daily_limit: amount, updated_at: new Date().toISOString() }));
  },
  async setKillSwitch(userId, on) {
    check(await db().from("limits").upsert({ user_id: userId, kill_switch: on, updated_at: new Date().toISOString() }));
  },
  async claimSlot(userId, cooldownSeconds) {
    return check(await db().rpc("claim_action_slot", { p_user: userId, p_cooldown_seconds: cooldownSeconds }));
  },
  async releaseSlot(userId, claimedAt, previous) {
    check(await db().rpc("release_action_slot", { p_user: userId, p_claimed_at: claimedAt, p_previous: previous }));
  },
  async insertProposal(row) {
    const r = check(await db().from("proposals").insert(row).select("id").single());
    return (r as { id: string }).id;
  },
  async consumeProposal(id, userId, kind, minDelayMs) {
    return check(await db().rpc("consume_proposal", { p_id: id, p_user: userId, p_kind: kind, p_min_delay_ms: minDelayMs }));
  },
  async logAction(row) {
    check(await db().from("actions_log").insert({ ...row, detail: row.detail ?? {} }));
  },
  async upsertSession(userId, day, limitAtStart, tripped) {
    check(await db().from("sessions").upsert({ user_id: userId, day, limit_at_start: limitAtStart }, { onConflict: "user_id,day", ignoreDuplicates: true }));
    if (tripped) {
      check(await db().from("sessions").update({ tripped_at: new Date().toISOString() }).eq("user_id", userId).eq("day", day).is("tripped_at", null));
    }
  },
  async startPairing(code, tokenHash, ttl, maxPending) {
    return check(await db().rpc("start_pairing", { p_code: code, p_token_hash: tokenHash, p_ttl_seconds: ttl, p_max_pending: maxPending }));
  },
  async claimPairing(userId, code) {
    return check(await db().rpc("claim_pairing_code", { p_user: userId, p_code: code }));
  },
  async redeemPairing(tokenHash) {
    return check(await db().rpc("redeem_pairing", { p_token_hash: tokenHash }));
  },
};

// Short memo so a burst of glasses refreshes cannot exhaust the exchange rate limit.
function memo<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | null = null;
  return () => {
    const now = Date.now();
    if (!value || now - at > ttlMs) {
      at = now;
      value = fn().catch((e) => {
        value = null;
        throw e;
      });
    }
    return value;
  };
}

let exchangeCache: { fingerprint: string; ex: Exchange } | null = null;

function exchange(): Exchange {
  const baseUrl = env("EXCHANGE_BASE_URL");
  const apiKey = env("BYBIT_API_KEY");
  const apiSecret = env("BYBIT_API_SECRET");
  if (!baseUrl || !apiKey || !apiSecret) {
    throw new ApiError(503, "exchange_not_configured", "The exchange connection is not configured.");
  }
  const fingerprint = `${baseUrl}|${apiKey.length}|${apiSecret.length}`;
  if (exchangeCache?.fingerprint === fingerprint) return exchangeCache.ex;
  let client;
  try {
    client = createBybitClient({ baseUrl, apiKey, apiSecret });
  } catch (e) {
    if (e instanceof TestnetGuardError) {
      throw new ApiError(503, "exchange_misconfigured", "Refusing to start: the exchange URL is not the testnet.");
    }
    throw e;
  }
  const positions = memo(2000, () => client.getPositions());
  const closed = new Map<string, ReturnType<typeof memo<number>>>();
  const ex: Exchange = {
    serverTimeMs: () => client.serverTimeMs(),
    getPositions: positions,
    getClosedPnl: (start, end) => {
      const key = String(start);
      if (!closed.has(key)) closed.clear(); // one UTC day at a time
      const m = closed.get(key) ?? memo(2000, () => client.getClosedPnl(start, end));
      closed.set(key, m);
      return m();
    },
    getInstrument: (s) => client.getInstrument(s),
    placeReduceOnlyMarket: (o, id) => client.placeReduceOnlyMarket(o, id),
  };
  exchangeCache = { fingerprint, ex };
  return ex;
}

async function verifyJwt(jwt: string): Promise<{ userId: string } | null> {
  const url = env("SUPABASE_URL");
  const anon = env("SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(jwt);
  return error || !data.user ? null : { userId: data.user.id };
}

export const handlers = makeHandlers({
  store,
  exchange,
  now: () => Date.now(),
  groqKey: () => env("GROQ_API_KEY"),
  region: () => env("SB_REGION") ?? env("DENO_REGION"),
  findDeviceByHash: async (hash) =>
    check(await db().from("devices").select("id,user_id").eq("token_hash", hash).is("revoked_at", null).maybeSingle()),
  touchDevice: async (id) => {
    await db().from("devices").update({ last_seen_at: new Date().toISOString() }).eq("id", id);
  },
  verifyJwt,
});
