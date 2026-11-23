import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHandlers, type Deps } from "./routes.ts";
import { sha256Hex } from "./api.ts";
import { type ExchangeAdapter, ExchangeError, type OpenPosition } from "./exchange.ts";
import type { PlannedOrder } from "./actions.ts";
import type { ActionLogRow, ClaimResult, LimitsRow, Store } from "./service.ts";

const USER = "11111111-1111-1111-1111-111111111111";
const TOKEN = "t".repeat(43);
const DEVICE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const JWT = "user.jwt.token";

interface World {
  clock: number;
  limits: LimitsRow;
  logs: ActionLogRow[];
  proposals: Map<string, { user: string; kind: string; orders: PlannedOrder[]; created: number; expires: number; consumed: boolean }>;
  pairing: Map<string, { code: string; hash: string; user: string | null; expires: number }>;
  devices: Map<string, { id: string; user_id: string }>;
  sessions: string[];
  claimResult: "real" | "rate_limited";
  positions: OpenPosition[];
  realized: number;
  placed: { order: PlannedOrder; linkId: string }[];
  placeError: ((o: PlannedOrder) => Error | null) | null;
  exchangeError: Error | null;
  dbDown: boolean;
  panelCalls: Record<string, unknown>[];
  panelError: Error | null;
}

function newWorld(): World {
  return {
    clock: Date.UTC(2026, 10, 23, 12, 0, 0),
    limits: { daily_limit: 500, kill_switch: false, last_action_at: null },
    logs: [], proposals: new Map(), pairing: new Map(), devices: new Map(), sessions: [],
    claimResult: "real", positions: [], realized: 0, placed: [], placeError: null, exchangeError: null, dbDown: false, panelCalls: [], panelError: null,
  };
}

function build(w: World, extra: Partial<Deps> = {}) {
  let seq = 0;
  const store: Store = {
    async ping() { if (w.dbDown) throw new Error("db down"); },
    async getLimits() { return { ...w.limits }; },
    async setLimit(_u, amount) { w.limits.daily_limit = amount; },
    async setKillSwitch(_u, on) { w.limits.kill_switch = on; },
    async claimSlot(_u, cooldownSeconds): Promise<ClaimResult> {
      if (w.limits.kill_switch) return { ok: false, reason: "kill_switch", retry_after_seconds: 0, previous: w.limits.last_action_at };
      const prev = w.limits.last_action_at;
      if (prev && w.clock < Date.parse(prev) + cooldownSeconds * 1000) {
        return { ok: false, reason: "cooldown", retry_after_seconds: Math.ceil((Date.parse(prev) + cooldownSeconds * 1000 - w.clock) / 1000), previous: prev };
      }
      const at = new Date(w.clock).toISOString();
      w.limits.last_action_at = at;
      return { ok: true, reason: null, retry_after_seconds: 0, previous: prev, claimed_at: at };
    },
    async releaseSlot(_u, claimedAt, previous) { if (w.limits.last_action_at === claimedAt) w.limits.last_action_at = previous; },
    async insertProposal(row) {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      w.proposals.set(id, { user: row.user_id, kind: row.kind, orders: row.orders, created: w.clock, expires: Date.parse(row.expires_at), consumed: false });
      return id;
    },
    async consumeProposal(id, user, kind, minDelayMs) {
      const p = w.proposals.get(id);
      if (!p || p.user !== user) return { ok: false, reason: "missing" };
      if (p.consumed) return { ok: false, reason: "consumed" };
      if (w.clock >= p.expires) return { ok: false, reason: "expired" };
      if (p.kind !== kind) return { ok: false, reason: "kind_mismatch" };
      if (w.clock < p.created + minDelayMs) return { ok: false, reason: "too_soon" };
      p.consumed = true;
      return { ok: true, reason: null, orders: p.orders };
    },
    async logAction(row) { w.logs.push(row); },
    async upsertSession(_u, day, _l, tripped) { w.sessions.push(`${day}:${tripped}`); },
    async startPairing(code, hash, ttl) {
      if (w.pairing.has(code)) return { ok: false, reason: "collision" };
      w.pairing.set(code, { code, hash, user: null, expires: w.clock + ttl * 1000 });
      return { ok: true, reason: null };
    },
    async claimPairing(user, code) {
      if (w.claimResult === "rate_limited") return { ok: false, reason: "rate_limited" };
      const p = w.pairing.get(code);
      if (!p || p.user || p.expires <= w.clock) return { ok: false, reason: "invalid_code" };
      p.user = user;
      return { ok: true, reason: null };
    },
    async redeemPairing(hash) {
      for (const p of w.pairing.values()) {
        if (p.hash !== hash) continue;
        if (p.user) { w.devices.set(hash, { id: DEVICE_ID, user_id: p.user }); w.pairing.delete(p.code); return { status: "paired", device_id: DEVICE_ID }; }
        return p.expires <= w.clock ? { status: "expired" } : { status: "pending" };
      }
      return w.devices.has(hash) ? { status: "paired", device_id: DEVICE_ID } : { status: "unknown" };
    },
  };

  const exchange: ExchangeAdapter = {
    mode: "PAPER",
    async health() { if (w.exchangeError) throw w.exchangeError; return { priceAgeMs: 1200 }; },
    async getPositions() { if (w.exchangeError) throw w.exchangeError; return w.positions; },
    async getRealizedSince() { if (w.exchangeError) throw w.exchangeError; return w.realized; },
    async getInstrument() { return { qtyStep: 0.001, minOrderQty: 0.001, status: "Trading" }; },
    async placeReduceOnlyMarket(_userId, order, linkId) {
      const err = w.placeError?.(order);
      if (err) throw err;
      w.placed.push({ order, linkId });
      return { orderId: `ord-${w.placed.length}`, orderLinkId: linkId };
    },
  };

  const panelCalls = w.panelCalls;
  const panel = {
    async open(userId: string, symbol: unknown, side: unknown, size: unknown, clientId: string) {
      panelCalls.push({ fn: "open", userId, symbol, side, size, clientId });
      if (w.panelError) throw w.panelError;
      return { fillId: "f-1", duplicate: false, balance: 9990, position: null };
    },
    async close(userId: string, symbol: unknown, size: unknown, clientId: string) {
      panelCalls.push({ fn: "close", userId, symbol, size, clientId });
      if (w.panelError) throw w.panelError;
      return { fillId: "f-2", duplicate: false, balance: 10000, position: null };
    },
    async reset(userId: string) { panelCalls.push({ fn: "reset", userId }); if (w.panelError) throw w.panelError; },
    async accountView(userId: string, dayStartMs: number) {
      panelCalls.push({ fn: "view", userId, dayStartMs });
      if (w.exchangeError) throw w.exchangeError;
      return { balance: 10000, equity: 10000, positions: [], fills: [], prices: [] } as never;
    },
  };
  const feed = {
    async getQuotes() {
      if (w.exchangeError) throw w.exchangeError;
      return new Map(["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD"].map((symbol) => [symbol, { symbol, bid: 60000, ask: 60001, last: 60000.5, sourceTs: w.clock, fetchedAt: w.clock - 2000 }]));
    },
  };
  const deps: Deps = {
    store,
    exchange: () => exchange,
    paper: panel,
    prices: feed,
    now: () => w.clock,
    groqKey: () => "gsk_test",
    region: () => "eu-west-1",
    findDeviceByHash: async (hash) => (hash === (await sha256Hex(TOKEN)) ? { id: DEVICE_ID, user_id: USER } : w.devices.get(hash) ?? null),
    touchDevice: async () => {},
    verifyJwt: async (jwt) => (jwt === JWT ? { userId: USER } : null),
    sleep: async () => {},
    ...extra,
  };
  return makeHandlers(deps);
}

const device = { "x-device-token": TOKEN };
const user = { authorization: `Bearer ${JWT}` };
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/fn", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const call = async (h: (r: Request) => Promise<Response>, r: Request) => {
  const res = await h(r);
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null, res };
};
const long = (size: number, pnl: number, symbol = "BTCUSDT"): OpenPosition => ({
  symbol, side: "Buy", size, positionIdx: 0, avgPrice: 60000, markPrice: 59000, unrealisedPnl: pnl,
});

// ---------------------------------------------------------------- basics

test("OPTIONS preflight returns CORS headers; wrong method is 405", async () => {
  const h = build(newWorld());
  const pre = await h.limits(new Request("http://localhost/fn", { method: "OPTIONS" }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-headers")!, /x-device-token/);
  assert.match(pre.headers.get("access-control-allow-headers")!, /x-region/);
  const bad = await call(h.positions, req("POST", {}, device));
  assert.equal(bad.status, 405);
  assert.equal(bad.res.headers.get("access-control-allow-origin"), "*");
});

test("health: ok when db and exchange respond, degraded (still 200) otherwise", async () => {
  const w = newWorld();
  const h = build(w);
  let r = await call(h.health, req("GET"));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body!.ok, r.body!.db, r.body!.priceSource.status, r.body!.priceSource.ageMs, r.body!.region, r.body!.voice, r.body!.mode], [true, "ok", "ok", 1200, "eu-west-1", "configured", "PAPER"]);
  w.dbDown = true;
  w.exchangeError = new ExchangeError("prices_unavailable", "source down");
  r = await call(h.health, req("GET"));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body!.ok, r.body!.db, r.body!.priceSource.status], [false, "error", "prices_unavailable"]);
});

test("authentication: missing, malformed, unknown and publishable-key credentials are 401", async () => {
  const h = build(newWorld());
  const cases: Record<string, string>[] = [
    {},
    { "x-device-token": "short" },
    { "x-device-token": "u".repeat(43) },
    { authorization: "Bearer sb_publishable_example_not_a_jwt" },
    { authorization: "Basic abc" },
  ];
  for (const headers of cases) {
    const r = await call(h.positions, req("GET", undefined, headers));
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(r.body!.error.code, "unauthorized");
  }
});

test("bodies: invalid JSON is 400, oversized is 413", async () => {
  const h = build(newWorld());
  const bad = await h.limits(new Request("http://localhost/fn", { method: "POST", headers: device, body: "{nope" }));
  assert.equal(bad.status, 400);
  const big = await h.limits(new Request("http://localhost/fn", { method: "POST", headers: device, body: JSON.stringify({ limit: 5, pad: "x".repeat(9000) }) }));
  assert.equal(big.status, 413);
  const arr = await h.limits(new Request("http://localhost/fn", { method: "POST", headers: device, body: "[1]" }));
  assert.equal(arr.status, 400);
});

// ---------------------------------------------------------------- limits

test("limits: device can set a valid limit, which is logged; bad values are 400", async () => {
  const w = newWorld();
  w.limits.daily_limit = null;
  const h = build(w);
  assert.equal((await call(h.limits, req("GET", undefined, device))).body!.limit, null);
  const ok = await call(h.limits, req("POST", { limit: 750 }, device));
  assert.deepEqual([ok.status, ok.body!.limit], [200, 750]);
  assert.deepEqual(w.logs[0]!.detail, { from: null, to: 750, via: "device" });
  for (const limit of [0, -1, 1e9, "500", null, NaN]) {
    const r = await call(h.limits, req("POST", { limit }, device));
    assert.equal(r.status, 400, String(limit));
  }
  assert.equal(w.limits.daily_limit, 750);
});

test("kill switch: only the website session may change it", async () => {
  const w = newWorld();
  const h = build(w);
  assert.equal((await call(h.limits, req("POST", { killSwitch: true }, device))).status, 403);
  assert.equal(w.limits.kill_switch, false);
  const r = await call(h.limits, req("POST", { killSwitch: true }, user));
  assert.deepEqual([r.status, r.body!.killSwitch], [200, true]);
  assert.equal((await call(h.limits, req("POST", { killSwitch: "yes" }, user))).status, 400);
  assert.equal((await call(h.limits, req("POST", {}, user))).status, 400);
});

// ---------------------------------------------------------------- positions

test("positions: NO_LIMIT, CALM, CLOSING and TRIPPED from live exchange data", async () => {
  const w = newWorld();
  const h = build(w);
  w.limits.daily_limit = null;
  assert.equal((await call(h.positions, req("GET", undefined, device))).body!.state, "NO_LIMIT");

  w.limits.daily_limit = 500;
  w.positions = [long(0.5, -88)];
  let r = await call(h.positions, req("GET", undefined, device));
  assert.deepEqual([r.body!.state, r.body!.left, r.body!.used], ["CALM", 412, 88]);
  assert.equal(r.body!.positions.length, 1);

  w.realized = -300;
  w.positions = [long(0.5, -104)];
  r = await call(h.positions, req("GET", undefined, device));
  assert.deepEqual([r.body!.state, r.body!.left], ["CLOSING", 96]);

  w.realized = -450;
  r = await call(h.positions, req("GET", undefined, device));
  assert.deepEqual([r.body!.state, r.body!.left], ["TRIPPED", 0]);
  assert.ok(w.sessions.some((s) => s.endsWith(":true")));
});

test("positions: empty account is an honest empty list, not an error", async () => {
  const h = build(newWorld());
  const r = await call(h.positions, req("GET", undefined, device));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body!.state, r.body!.positions, r.body!.left], ["CALM", [], 500]);
});

test("positions: price failures map to honest 5xx codes and never show CALM", async () => {
  const w = newWorld();
  const h = build(w);
  const cases: [ExchangeError, number, string][] = [
    [new ExchangeError("prices_stale", "old"), 503, "prices_stale"],
    [new ExchangeError("prices_unavailable", "down"), 503, "prices_unavailable"],
    [new ExchangeError("rejected", "nope", "insufficient_margin"), 409, "insufficient_margin"],
  ];
  for (const [err, status, code] of cases) {
    w.exchangeError = err;
    const r = await call(h.positions, req("GET", undefined, device));
    assert.deepEqual([r.status, r.body!.error.code, r.body!.state], [status, code, undefined]);
  }
});

test("positions: absurd PnL from the exchange is rejected, not displayed", async () => {
  const w = newWorld();
  w.positions = [long(1, NaN)];
  const r = await call(build(w).positions, req("GET", undefined, device));
  assert.equal(r.status, 502);
});

test("positions: a huge position list is passed through without breaking", async () => {
  const w = newWorld();
  w.positions = Array.from({ length: 300 }, (_, i) => long(1e9, -0.01, `SYM${i}USDT`));
  const r = await call(build(w).positions, req("GET", undefined, device));
  assert.equal(r.status, 200);
  assert.equal(r.body!.positions.length, 300);
});

// ---------------------------------------------------------------- act

const propose = (h: ReturnType<typeof build>, kind: string, headers = device) => call(h.act, req("POST", { action: "propose", kind }, headers));
const confirmReq = (h: ReturnType<typeof build>, proposalId: string, kind: string, headers = device) =>
  call(h.act, req("POST", { action: "confirm", proposalId, kind }, headers));

test("act: propose then confirm places REDUCE-ONLY orders, logs them, starts the cooldown", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100), { ...long(2, 5, "ETHUSDT"), side: "Sell" }];
  const h = build(w);
  const p = await propose(h, "cut_half");
  assert.equal(p.status, 200);
  assert.deepEqual(p.body!.orders, [
    { symbol: "BTCUSDT", side: "Sell", qty: "0.250" },
    { symbol: "ETHUSDT", side: "Buy", qty: "1.000" },
  ]);
  w.clock += 1500;
  const c = await confirmReq(h, p.body!.proposalId, "cut_half");
  assert.equal(c.status, 200);
  assert.deepEqual([c.body!.executed, c.body!.failed], [2, 0]);
  assert.equal(w.placed.length, 2);
  assert.ok(w.placed.every((x) => x.order.reduceOnly === true));
  assert.ok(w.placed.every((x) => /^hl-[0-9a-f-]{8}-\d$/.test(x.linkId) && x.linkId.length <= 36));
  const executed = w.logs.filter((l) => l.status === "executed");
  assert.equal(executed.length, 2);
  assert.deepEqual(executed.map((l) => [l.symbol, l.side, l.size]), [["BTCUSDT", "Sell", 0.25], ["ETHUSDT", "Buy", 1]]);
  assert.ok(w.limits.last_action_at);
});

test("act: a double press cannot place orders twice (consume-once)", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100)];
  const h = build(w);
  const p = await propose(h, "cut_all");
  w.clock += 1500;
  const [a, b] = await Promise.all([confirmReq(h, p.body!.proposalId, "cut_all"), confirmReq(h, p.body!.proposalId, "cut_all")]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(w.placed.length, 1);
});

test("act: a confirm that arrives too fast is rejected and does not burn the proposal", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100)];
  const h = build(w);
  const p = await propose(h, "cut_half");
  const early = await confirmReq(h, p.body!.proposalId, "cut_half");
  assert.deepEqual([early.status, early.body!.error.code], [425, "too_soon"]);
  assert.equal(w.placed.length, 0);
  w.clock += 1500;
  assert.equal((await confirmReq(h, p.body!.proposalId, "cut_half")).status, 200);
});

test("act: expired, mismatched, unknown and malformed confirmations are refused and logged", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100)];
  const h = build(w);
  const p = await propose(h, "cut_half");
  const id = p.body!.proposalId as string;
  w.clock += 1500;
  assert.equal((await confirmReq(h, id, "cut_all")).body!.error.code, "kind_mismatch");
  assert.equal((await confirmReq(h, "00000000-0000-4000-8000-0000000000ff", "cut_half")).body!.error.code, "missing");
  assert.equal((await confirmReq(h, "not-a-uuid", "cut_half")).status, 400);
  assert.equal((await confirmReq(h, id, "dismiss")).status, 400);
  w.clock += 60_000;
  assert.equal((await confirmReq(h, id, "cut_half")).body!.error.code, "expired");
  assert.equal(w.placed.length, 0);
  assert.ok(w.logs.some((l) => l.status === "rejected" && l.reason === "expired"));
});

test("act: the cooldown blocks a second action, then clears", async () => {
  const w = newWorld();
  w.positions = [long(2, -100)];
  const h = build(w);
  const p1 = await propose(h, "cut_half");
  w.clock += 1500;
  assert.equal((await confirmReq(h, p1.body!.proposalId, "cut_half")).status, 200);

  const again = await propose(h, "cut_half");
  assert.deepEqual([again.status, again.body!.error.code], [429, "cooldown"]);
  assert.ok(again.body!.error.retryAfterMs > 0);

  w.clock += 61_000;
  assert.equal((await propose(h, "cut_half")).status, 200);
});

test("act: cooldown cannot be bypassed by holding a second proposal made earlier", async () => {
  const w = newWorld();
  w.positions = [long(2, -100)];
  const h = build(w);
  const p1 = await propose(h, "cut_half");
  const p2 = await propose(h, "cut_half"); // both made before any action
  w.clock += 1500;
  assert.equal((await confirmReq(h, p1.body!.proposalId, "cut_half")).status, 200);
  const second = await confirmReq(h, p2.body!.proposalId, "cut_half");
  assert.deepEqual([second.status, second.body!.error.code], [429, "cooldown"]);
  assert.equal(w.placed.length, 1);
});

test("act: the kill switch blocks proposals and confirmations", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100)];
  const h = build(w);
  const p = await propose(h, "cut_half");
  w.clock += 1500;
  w.limits.kill_switch = true;
  assert.equal((await propose(h, "cut_all")).body!.error.code, "kill_switch");
  const c = await confirmReq(h, p.body!.proposalId, "cut_half");
  assert.deepEqual([c.status, c.body!.error.code], [403, "kill_switch"]);
  assert.equal(w.placed.length, 0);
});

test("act: dismiss needs no confirmation, places nothing, and is logged", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100)];
  const r = await propose(build(w), "dismiss");
  assert.deepEqual([r.status, r.body!.dismissed], [200, true]);
  assert.equal(w.placed.length, 0);
  assert.equal(w.logs[0]!.kind, "dismiss");
});

test("act: an unknown kind or action is 400; no positions is an honest 409", async () => {
  const w = newWorld();
  const h = build(w);
  assert.equal((await propose(h, "cut_everything")).status, 400);
  assert.equal((await call(h.act, req("POST", { action: "nuke" }, device))).status, 400);
  const none = await propose(h, "cut_half");
  assert.deepEqual([none.status, none.body!.error.code], [409, "no_positions"]);
});

test("act: dust positions below the minimum are reported, not rounded up", async () => {
  const w = newWorld();
  w.positions = [long(0.001, -1)];
  const r = await propose(build(w), "cut_half");
  assert.deepEqual([r.status, r.body!.error.code], [409, "nothing_to_reduce"]);
  assert.equal(r.body!.error.skipped[0].reason, "below_min_qty");
});

test("act: if every order fails the slot is released so the user can retry; failures are logged", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100)];
  w.placeError = () => new ExchangeError("rejected", "That is larger than the open position.", "reduce_only_exceeds_position");
  const h = build(w);
  const p = await propose(h, "cut_all");
  w.clock += 1500;
  const c = await confirmReq(h, p.body!.proposalId, "cut_all");
  assert.equal(c.status, 200);
  assert.deepEqual([c.body!.executed, c.body!.failed, c.body!.results[0].reason], [0, 1, "reduce_only_exceeds_position"]);
  assert.equal(w.limits.last_action_at, null, "cooldown must not be consumed by a total failure");
  assert.ok(w.logs.some((l) => l.status === "failed" && l.reason === "reduce_only_exceeds_position"));
  // and a retry is possible
  w.placeError = null;
  assert.equal((await propose(h, "cut_all")).status, 200);
});

test("act: a partial failure keeps the cooldown (something was executed)", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100), long(1, -5, "ETHUSDT")];
  w.placeError = (o) => (o.symbol === "ETHUSDT" ? new ExchangeError("rejected", "nope", "insufficient_margin") : null);
  const h = build(w);
  const p = await propose(h, "cut_all");
  w.clock += 1500;
  const c = await confirmReq(h, p.body!.proposalId, "cut_all");
  assert.deepEqual([c.body!.executed, c.body!.failed], [1, 1]);
  assert.ok(w.limits.last_action_at);
});

test("act: another user's proposal cannot be confirmed", async () => {
  const w = newWorld();
  w.positions = [long(0.5, -100)];
  const h = build(w);
  const p = await propose(h, "cut_half");
  w.clock += 1500;
  w.proposals.get(p.body!.proposalId)!.user = "99999999-9999-9999-9999-999999999999";
  assert.equal((await confirmReq(h, p.body!.proposalId, "cut_half")).body!.error.code, "missing");
});

// ---------------------------------------------------------------- pairing

test("pairing: start -> pending -> website claim -> paired -> device token works", async () => {
  const w = newWorld();
  const h = build(w);
  const s = await call(h.pair, req("POST", { action: "start" }));
  assert.equal(s.status, 200);
  assert.match(s.body!.code, /^\d{6}$/);
  assert.ok((s.body!.token as string).length >= 32);
  assert.equal(s.body!.expiresInSeconds, 600);

  const poll = () => call(h.pair, req("POST", { action: "poll" }, { "x-device-token": s.body!.token }));
  assert.equal((await poll()).body!.status, "pending");

  const claim = await call(h.pair, req("POST", { action: "claim", code: s.body!.code }, user));
  assert.deepEqual([claim.status, claim.body!.paired], [200, true]);
  assert.equal((await poll()).body!.status, "paired");

  // the fresh token now authenticates
  const lim = await call(h.limits, req("GET", undefined, { "x-device-token": s.body!.token }));
  assert.equal(lim.status, 200);
});

test("pairing: the code is never returned by poll, and the token never by claim", async () => {
  const h = build(newWorld());
  const s = await call(h.pair, req("POST", { action: "start" }));
  const poll = await call(h.pair, req("POST", { action: "poll" }, { "x-device-token": s.body!.token }));
  assert.equal(JSON.stringify(poll.body).includes(s.body!.code), false);
  const claim = await call(h.pair, req("POST", { action: "claim", code: s.body!.code }, user));
  assert.equal(JSON.stringify(claim.body).includes(s.body!.token), false);
});

test("pairing: claim needs a website session; wrong, malformed and rate-limited codes are refused", async () => {
  const w = newWorld();
  const h = build(w);
  const s = await call(h.pair, req("POST", { action: "start" }));
  assert.equal((await call(h.pair, req("POST", { action: "claim", code: s.body!.code }))).status, 401);
  assert.equal((await call(h.pair, req("POST", { action: "claim", code: s.body!.code }, device))).status, 403);
  assert.equal((await call(h.pair, req("POST", { action: "claim", code: "000000" }, user))).body!.error.code, "invalid_code");
  for (const code of ["12345", "1234567", "abcdef", 123456, null, undefined]) {
    assert.equal((await call(h.pair, req("POST", { action: "claim", code }, user))).status, 400, String(code));
  }
  w.claimResult = "rate_limited";
  const rl = await call(h.pair, req("POST", { action: "claim", code: s.body!.code }, user));
  assert.deepEqual([rl.status, rl.body!.error.code], [429, "rate_limited"]);
});

test("pairing: start is rate limited and poll needs a well-formed token", async () => {
  const w = newWorld();
  const h = build(w);
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await call(h.pair, req("POST", { action: "start" }))).status;
  assert.equal(last, 429);
  assert.equal((await call(h.pair, req("POST", { action: "poll" }))).status, 401);
  assert.equal((await call(h.pair, req("POST", { action: "wat" }))).status, 400);
});

// ---------------------------------------------------------------- transcribe

const audioReq = (headers: Record<string, string>, body: BodyInit = new Uint8Array([1, 2, 3])) =>
  new Request("http://localhost/fn", { method: "POST", headers, body });

test("transcribe: returns the transcript and the parsed command, writes nothing", async () => {
  const w = newWorld();
  const fetchFn = (async () => new Response(JSON.stringify({ text: "Set limit to five hundred dollars." }), { status: 200 })) as unknown as typeof fetch;
  const h = build(w, { fetchFn });
  const r = await call(h.transcribe, audioReq({ ...device, "content-type": "audio/wav" }));
  assert.equal(r.status, 200);
  assert.equal(r.body!.text, "Set limit to five hundred dollars.");
  assert.deepEqual(r.body!.command, { kind: "set_limit", amount: 500 });
  assert.equal(w.limits.daily_limit, 500, "voice must not write the limit itself");
  assert.equal(w.logs.length, 0);
});

test("transcribe: Groq down or rate limited gives a visible, typed failure", async () => {
  const down = build(newWorld(), { fetchFn: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
  const r1 = await call(down.transcribe, audioReq({ ...device, "content-type": "audio/wav" }));
  assert.deepEqual([r1.status, r1.body!.error.code], [503, "voice_unavailable"]);

  const limited = build(newWorld(), {
    fetchFn: (async () => new Response("", { status: 429, headers: { "retry-after": "40" } })) as unknown as typeof fetch,
  });
  const r2 = await call(limited.transcribe, audioReq({ ...device, "content-type": "audio/wav" }));
  assert.deepEqual([r2.status, r2.body!.error.code, r2.body!.error.retryAfterMs], [429, "voice_rate_limited", 40000]);
});

test("transcribe: no key, bad type, empty and oversized audio are refused", async () => {
  const noKey = build(newWorld(), { groqKey: () => undefined });
  assert.equal((await call(noKey.transcribe, audioReq({ ...device, "content-type": "audio/wav" }))).body!.error.code, "voice_unavailable");
  const h = build(newWorld());
  assert.equal((await call(h.transcribe, audioReq({ ...device, "content-type": "text/plain" }))).body!.error.code, "bad_audio");
  assert.equal((await call(h.transcribe, audioReq({ ...device, "content-type": "audio/wav" }, new Uint8Array(0)))).body!.error.code, "bad_audio");
  assert.equal((await call(h.transcribe, audioReq({ ...device, "content-type": "audio/wav" }, new Uint8Array(1_100_000)))).status, 413);
  assert.equal((await call(h.transcribe, audioReq({ "content-type": "audio/wav" }))).status, 401);
});

test("transcribe: per-user limiter protects the shared free-tier quota", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 })) as unknown as typeof fetch;
  const h = build(newWorld(), { fetchFn });
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call(h.transcribe, audioReq({ ...device, "content-type": "audio/wav" }))).status;
  assert.equal(last, 429);
});

test("errors never leak internals", async () => {
  const w = newWorld();
  const h = build(w, { findDeviceByHash: async () => { throw new Error("password=hunter2 host=db.internal"); } });
  const prev = console.error;
  console.error = () => {};
  try {
    const r = await call(h.positions, req("GET", undefined, device));
    assert.equal(r.status, 500);
    assert.equal(JSON.stringify(r.body).includes("hunter2"), false);
  } finally {
    console.error = prev;
  }
});

// ---------------------------------------------------------------- PAPER label, paper panel, prices

test("every JSON response, including errors and 404-ish ones, is labelled PAPER", async () => {
  const w = newWorld();
  const h = build(w);
  w.positions = [long(0.5, -10)];
  const ok = await call(h.positions, req("GET", undefined, device));
  assert.equal(ok.body!.mode, "PAPER");
  const err = await call(h.positions, req("GET"));
  assert.equal(err.body!.mode, "PAPER");
  const lim = await call(h.limits, req("GET", undefined, device));
  assert.equal(lim.body!.mode, "PAPER");
  const bad = await call(h.act, req("POST", { action: "x" }, device));
  assert.equal(bad.body!.mode, "PAPER");
});

test("paper panel: GET works for device and user; writes are website-only", async () => {
  const w = newWorld();
  const h = build(w);
  assert.equal((await call(h.paper, req("GET", undefined, device))).status, 200);
  assert.equal((await call(h.paper, req("GET", undefined, user))).status, 200);
  const denied = await call(h.paper, req("POST", { action: "open", symbol: "BTCUSD", side: "Buy", size: 0.1, clientId: "click-0001" }, device));
  assert.equal(denied.status, 403);
  assert.equal(w.panelCalls.filter((c) => c.fn === "open").length, 0);
  assert.equal((await call(h.paper, req("POST", { action: "open" }))).status, 401);
});

test("paper panel: open and close pass validated input through with an idempotency key", async () => {
  const w = newWorld();
  const h = build(w);
  const open = await call(h.paper, req("POST", { action: "open", symbol: "BTCUSD", side: "Buy", size: 0.1, clientId: "click-0001" }, user));
  assert.deepEqual([open.status, open.body!.fillId, open.body!.mode], [200, "f-1", "PAPER"]);
  assert.deepEqual(w.panelCalls.at(-1), { fn: "open", userId: USER, symbol: "BTCUSD", side: "Buy", size: 0.1, clientId: "web-click-0001" });
  const close = await call(h.paper, req("POST", { action: "close", symbol: "BTCUSD", clientId: "click-0002" }, user));
  assert.equal(close.status, 200);
  assert.deepEqual(w.panelCalls.at(-1), { fn: "close", userId: USER, symbol: "BTCUSD", size: undefined, clientId: "web-click-0002" });
  assert.equal((await call(h.paper, req("POST", { action: "reset" }, user))).body!.reset, true);
});

test("paper panel: a missing or malformed clientId is rejected before anything runs", async () => {
  const w = newWorld();
  const h = build(w);
  for (const clientId of [undefined, "short", "has spaces here", "x".repeat(40), 12345678, null]) {
    const r = await call(h.paper, req("POST", { action: "open", symbol: "BTCUSD", side: "Buy", size: 1, clientId }, user));
    assert.equal(r.status, 400, String(clientId));
  }
  assert.equal(w.panelCalls.length, 0);
  assert.equal((await call(h.paper, req("POST", { action: "explode" }, user))).status, 400);
});

test("paper panel: account rejections and stale prices surface as honest errors", async () => {
  const w = newWorld();
  const h = build(w);
  w.panelError = new ExchangeError("rejected", "Not enough margin.", "insufficient_margin");
  const r1 = await call(h.paper, req("POST", { action: "open", symbol: "BTCUSD", side: "Buy", size: 5, clientId: "click-0003" }, user));
  assert.deepEqual([r1.status, r1.body!.error.code], [409, "insufficient_margin"]);
  w.panelError = new ExchangeError("prices_stale", "old");
  const r2 = await call(h.paper, req("POST", { action: "open", symbol: "BTCUSD", side: "Buy", size: 1, clientId: "click-0004" }, user));
  assert.deepEqual([r2.status, r2.body!.error.code], [503, "prices_stale"]);
  w.panelError = new ExchangeError("bad_request", "Size must be a multiple of 0.0001.");
  assert.equal((await call(h.paper, req("POST", { action: "open", symbol: "BTCUSD", side: "Buy", size: 0.00005, clientId: "click-0005" }, user))).status, 400);
});

test("paper panel: writes are rate limited per user", async () => {
  const w = newWorld();
  const h = build(w);
  let last = 0;
  for (let i = 0; i < 32; i++) last = (await call(h.paper, req("POST", { action: "reset" }, user))).status;
  assert.equal(last, 429);
});

test("prices: public, labelled, shows age, and fails honestly when the source is down", async () => {
  const w = newWorld();
  const h = build(w);
  const r = await call(h.prices, req("GET"));
  assert.equal(r.status, 200);
  assert.equal(r.body!.mode, "PAPER");
  assert.match(r.body!.source, /Bitstamp/);
  assert.deepEqual(r.body!.quotes.map((q: any) => q.symbol), ["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD"]);
  assert.deepEqual([r.body!.quotes[0].bid, r.body!.quotes[0].ageMs], [60000, 2000]);
  w.exchangeError = new ExchangeError("prices_unavailable", "down");
  const down = await call(h.prices, req("GET"));
  assert.deepEqual([down.status, down.body!.error.code], [503, "prices_unavailable"]);
});
