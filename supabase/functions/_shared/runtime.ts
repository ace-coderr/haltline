// Deno runtime wiring: real Supabase client, real exchange client, real clock.
// Kept out of the Node typecheck/tests (it uses Deno globals and an npm: import); it is
// type-checked with `deno check` instead. All logic lives in the injected-dependency modules.
import { createClient } from "npm:@supabase/supabase-js@2";
import { ApiError } from "./api.ts";
import { createPaperExchange } from "./paper.ts";
import type { PaperStore } from "./paper.ts";
import { createPriceFeed } from "./prices.ts";
import type { PriceStore, Quote } from "./prices.ts";
import { makeHandlers } from "./routes.ts";
import type { Store } from "./service.ts";

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

const num = (v: unknown): number => Number(v);

const paperStore: PaperStore = {
  async getPositions(userId) {
    const rows = check(await db().from("paper_positions").select("symbol,side,size,entry_price").eq("user_id", userId));
    return (rows ?? []).map((r) => ({ symbol: r.symbol, side: r.side, size: num(r.size), entry_price: num(r.entry_price) }));
  },
  async getAccount(userId) {
    const r = check(await db().from("paper_accounts").select("balance,starting_balance").eq("user_id", userId).maybeSingle());
    return r ? { balance: num(r.balance), starting_balance: num(r.starting_balance) } : null;
  },
  async applyFill(a) {
    return check(await db().rpc("paper_apply_fill", {
      p_user: a.userId, p_symbol: a.symbol, p_side: a.side, p_qty: a.qty, p_price: a.price, p_fee_rate: a.feeRate,
      p_reduce_only: a.reduceOnly, p_link_id: a.linkId, p_source: a.source, p_max_leverage: a.maxLeverage,
      p_marks: a.marks, p_starting_balance: a.startingBalance,
    }));
  },
  async realizedSince(userId, sinceIso) {
    return num(check(await db().rpc("paper_realized_since", { p_user: userId, p_since: sinceIso })));
  },
  async listFills(userId, limit) {
    const rows = check(await db().from("paper_fills").select("id,symbol,side,qty,price,fee,realized_pnl,reduce_only,source,created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(limit));
    return rows ?? [];
  },
  async reset(userId, startingBalance) {
    return check(await db().rpc("paper_reset", { p_user: userId, p_starting_balance: startingBalance }));
  },
};

const priceStore: PriceStore = {
  async readQuotes() {
    const rows = check(await db().from("paper_prices").select("symbol,bid,ask,last,source_ts,fetched_at"));
    return (rows ?? []).map((r): Quote => ({
      symbol: r.symbol, bid: num(r.bid), ask: num(r.ask), last: num(r.last),
      sourceTs: Date.parse(r.source_ts), fetchedAt: Date.parse(r.fetched_at),
    }));
  },
  async writeQuotes(quotes) {
    check(await db().from("paper_prices").upsert(quotes.map((q) => ({
      symbol: q.symbol, bid: q.bid, ask: q.ask, last: q.last, source_ts: new Date(q.sourceTs).toISOString(),
      fetched_at: new Date(q.fetchedAt).toISOString(), source: "bitstamp",
    }))));
  },
};

const now = () => Date.now();
const prices = createPriceFeed({ store: priceStore, now });
const paper = createPaperExchange({ store: paperStore, prices, now });

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
  exchange: () => paper.adapter,
  paper: paper.panel,
  prices,
  now,
  groqKey: () => env("GROQ_API_KEY"),
  region: () => env("SB_REGION") ?? env("DENO_REGION"),
  findDeviceByHash: async (hash) =>
    check(await db().from("devices").select("id,user_id").eq("token_hash", hash).is("revoked_at", null).maybeSingle()),
  touchDevice: async (id) => {
    await db().from("devices").update({ last_seen_at: new Date().toISOString() }).eq("id", id);
  },
  verifyJwt,
});
