// The paper adapter running against the REAL SQL (pglite): fill pricing, marks, margin,
// reduce-only, idempotency and the stale-price fail-closed rule, end to end.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, USER_A } from "./db.ts";
import { createPaperExchange, fillPrice, markPrice, type PaperStore } from "../functions/_shared/paper.ts";
import { ExchangeError } from "../functions/_shared/exchange.ts";
import type { PriceFeed, Quote } from "../functions/_shared/prices.ts";
import { MODEL } from "../functions/_shared/instruments.ts";

let db: PGlite;
let now = Date.UTC(2026, 10, 23, 12, 0, 0);
let book: Record<string, { bid: number; ask: number }> = {};
let feedDown: ExchangeError | null = null;

const quote = (symbol: string): Quote => ({ symbol, bid: book[symbol]!.bid, ask: book[symbol]!.ask, last: book[symbol]!.bid, sourceTs: now, fetchedAt: now - 1000 });
const feed: PriceFeed = {
  async getQuotes(symbols) {
    if (feedDown) throw feedDown;
    const all = ["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD"].filter((s) => !symbols || symbols.includes(s));
    return new Map(all.filter((s) => book[s]).map((s) => [s, quote(s)] as const));
  },
};

const store: PaperStore = {
  async getPositions(userId) {
    return (await db.query<any>("select symbol,side,size::float8 as size,entry_price::float8 as entry_price from paper_positions where user_id=$1 order by symbol", [userId])).rows;
  },
  async getAccount(userId) {
    const r = (await db.query<any>("select balance::float8 as balance, starting_balance::float8 as starting_balance from paper_accounts where user_id=$1", [userId])).rows[0];
    return r ?? null;
  },
  async applyFill(a) {
    return (await db.query<any>("select paper_apply_fill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) as r",
      [a.userId, a.symbol, a.side, a.qty, a.price, a.feeRate, a.reduceOnly, a.linkId, a.source, a.maxLeverage, JSON.stringify(a.marks), a.startingBalance])).rows[0].r;
  },
  async realizedSince(userId, sinceIso) {
    return Number((await db.query<any>("select paper_realized_since($1,$2::timestamptz) as v", [userId, sinceIso])).rows[0].v);
  },
  async listFills(userId, limit) {
    return (await db.query<any>("select id,symbol,side,qty::float8 as qty,price::float8 as price,fee::float8 as fee,realized_pnl::float8 as realized_pnl,reduce_only,source,created_at::text as created_at from paper_fills where user_id=$1 order by created_at desc limit $2", [userId, limit])).rows;
  },
  async reset(userId, starting) {
    return (await db.query<any>("select paper_reset($1,$2) as r", [userId, starting])).rows[0].r;
  },
};

const px = createPaperExchange({ store, prices: feed, now: () => now });
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

before(async () => { db = await createDb(); });
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec("truncate paper_fills, paper_positions, paper_accounts cascade");
  book = { BTCUSD: { bid: 60000, ask: 60010 }, ETHUSD: { bid: 1700, ask: 1701 }, SOLUSD: { bid: 72, ask: 72.1 }, XRPUSD: { bid: 2, ask: 2.001 }, DOGEUSD: { bid: 0.2, ask: 0.2001 } };
  feedDown = null;
});

test("fill pricing: buys at ask + slippage, sells at bid - slippage; mark is the mid", () => {
  close(fillPrice("Buy", { bid: 100, ask: 101 }), 101 * 1.0001, 1e-7);
  close(fillPrice("Sell", { bid: 100, ask: 101 }), 100 * 0.9999, 1e-7);
  assert.equal(markPrice({ bid: 100, ask: 102 }), 101);
  assert.equal(MODEL.mode, "PAPER");
});

test("open a long at the live ask, then see it marked at the mid with unrealised PnL", async () => {
  const r = await px.panel.open(USER_A, "BTCUSD", "Buy", 0.1, "click-0001");
  assert.equal(r.duplicate, false);
  const [p] = await px.adapter.getPositions(USER_A);
  assert.equal(p!.symbol, "BTCUSD");
  close(p!.avgPrice, 60010 * 1.0001, 1e-4);
  close(p!.markPrice, 60005);
  close(p!.unrealisedPnl, (60005 - p!.avgPrice) * 0.1, 1e-4);
  assert.ok(p!.unrealisedPnl < 0, "the spread, slippage and fee make a fresh position start slightly red");
  book.BTCUSD = { bid: 61000, ask: 61010 };
  assert.ok((await px.adapter.getPositions(USER_A))[0]!.unrealisedPnl > 0);
});

test("an empty account needs no prices at all", async () => {
  feedDown = new ExchangeError("prices_unavailable", "down");
  assert.deepEqual(await px.adapter.getPositions(USER_A), []);
});

test("a repeated click with the same clientId is applied once", async () => {
  await px.panel.open(USER_A, "ETHUSD", "Buy", 1, "click-0002");
  const again = await px.panel.open(USER_A, "ETHUSD", "Buy", 1, "click-0002");
  assert.equal(again.duplicate, true);
  assert.equal((await px.adapter.getPositions(USER_A))[0]!.size, 1);
});

test("the guard's reduce-only order closes half, realises PnL net of fees, and counts toward today's loss", async () => {
  await px.panel.open(USER_A, "ETHUSD", "Buy", 2, "click-0003");
  book.ETHUSD = { bid: 1600, ask: 1601 }; // price drops
  const res = await px.adapter.placeReduceOnlyMarket(USER_A, { symbol: "ETHUSD", side: "Sell", qty: "1.000", positionIdx: 0, reduceOnly: true }, "hl-abcd1234-0");
  assert.ok(res.orderId);
  const [p] = await px.adapter.getPositions(USER_A);
  close(p!.size, 1);
  const realised = await px.adapter.getRealizedSince(USER_A, now - 3600_000);
  assert.ok(realised < -90 && realised > -110, `realised ${realised}`); // about -100 price loss minus fees
  const fills = (await px.panel.accountView(USER_A, now - 3600_000)).fills;
  assert.deepEqual(fills.map((f) => [f.source, f.reduceOnly]).sort(), [["guard", true], ["manual", false]]);
});

test("the guard cannot be tricked into opening or growing a position", async () => {
  await px.panel.open(USER_A, "ETHUSD", "Buy", 1, "click-0004");
  const order = { symbol: "ETHUSD", side: "Buy" as const, qty: "1.000", positionIdx: 0 as const, reduceOnly: true as const };
  await assert.rejects(px.adapter.placeReduceOnlyMarket(USER_A, order, "hl-aaaa1111-0"), (e: unknown) => e instanceof ExchangeError && e.reason === "reduce_only_wrong_side");
  await assert.rejects(px.adapter.placeReduceOnlyMarket(USER_A, { ...order, side: "Sell", qty: "5.000" }, "hl-aaaa1111-1"), (e: unknown) => e instanceof ExchangeError && e.reason === "reduce_only_exceeds_position");
  await assert.rejects(px.adapter.placeReduceOnlyMarket(USER_A, { ...order, side: "Sell", symbol: "SOLUSD" }, "hl-aaaa1111-2"), (e: unknown) => e instanceof ExchangeError && e.reason === "reduce_only_no_position");
  await assert.rejects(px.adapter.placeReduceOnlyMarket(USER_A, { ...order, reduceOnly: false } as any, "hl-aaaa1111-3"));
  await assert.rejects(px.adapter.placeReduceOnlyMarket(USER_A, { ...order, side: "Sell" }, "bad id"), (e: unknown) => e instanceof ExchangeError);
  assert.equal((await px.adapter.getPositions(USER_A))[0]!.size, 1);
});

test("STALE PRICES: no fills and no marks, nothing changes", async () => {
  await px.panel.open(USER_A, "BTCUSD", "Buy", 0.1, "click-0005");
  feedDown = new ExchangeError("prices_stale", "old");
  await assert.rejects(px.panel.open(USER_A, "BTCUSD", "Buy", 0.1, "click-0006"), (e: unknown) => e instanceof ExchangeError && e.kind === "prices_stale");
  await assert.rejects(px.panel.close(USER_A, "BTCUSD", undefined, "click-0007"), (e: unknown) => e instanceof ExchangeError && e.kind === "prices_stale");
  await assert.rejects(px.adapter.placeReduceOnlyMarket(USER_A, { symbol: "BTCUSD", side: "Sell", qty: "0.0500", positionIdx: 0, reduceOnly: true }, "hl-bbbb2222-0"), (e: unknown) => e instanceof ExchangeError && e.kind === "prices_stale");
  await assert.rejects(px.adapter.getPositions(USER_A), (e: unknown) => e instanceof ExchangeError);
  feedDown = null;
  const [p] = await px.adapter.getPositions(USER_A);
  close(p!.size, 0.1);
  assert.equal((await px.panel.accountView(USER_A, now - 3600_000)).fills.length, 1);
});

test("panel input validation: lots, side, symbol, size", async () => {
  const bad: [unknown, unknown, unknown][] = [
    ["BTCUSDT", "Buy", 0.1], ["BTCUSD", "Long", 0.1], ["BTCUSD", "Buy", 0], ["BTCUSD", "Buy", -1], ["BTCUSD", "Buy", NaN],
    ["BTCUSD", "Buy", "0.1"], ["BTCUSD", "Buy", 0.00001], ["BTCUSD", "Buy", 0.00015], ["DOGEUSD", "Buy", 15], [undefined, "Buy", 1],
  ];
  for (const [s, side, size] of bad) {
    await assert.rejects(px.panel.open(USER_A, s, side, size, "click-bad01"), (e: unknown) => e instanceof ExchangeError, `${String(s)} ${String(side)} ${String(size)}`);
  }
  await px.panel.open(USER_A, "DOGEUSD", "Sell", 100, "click-ok001"); // a valid short
  assert.equal((await px.adapter.getPositions(USER_A))[0]!.side, "Sell");
});

test("margin: a position far beyond 5x equity is refused with a clear reason", async () => {
  await assert.rejects(px.panel.open(USER_A, "BTCUSD", "Buy", 1, "click-big01"), (e: unknown) => e instanceof ExchangeError && e.reason === "insufficient_margin" && /5x/.test(e.message));
});

test("close: full by default, partial by size, never more than held, and reset needs a flat account", async () => {
  await px.panel.open(USER_A, "SOLUSD", "Buy", 10, "click-sol01");
  await assert.rejects(px.panel.close(USER_A, "SOLUSD", 11, "click-sol02"), (e: unknown) => e instanceof ExchangeError && e.kind === "bad_request");
  await assert.rejects(px.panel.close(USER_A, "ETHUSD", undefined, "click-sol03"), (e: unknown) => e instanceof ExchangeError && e.reason === "reduce_only_no_position");
  await px.panel.close(USER_A, "SOLUSD", 4, "click-sol04");
  close((await px.adapter.getPositions(USER_A))[0]!.size, 6);
  await assert.rejects(px.panel.reset(USER_A), (e: unknown) => e instanceof ExchangeError && e.reason === "has_positions");
  await px.panel.close(USER_A, "SOLUSD", undefined, "click-sol05");
  assert.deepEqual(await px.adapter.getPositions(USER_A), []);
  await px.panel.reset(USER_A);
  assert.equal((await store.getAccount(USER_A))!.balance, 10000);
});

test("account view: PAPER model, equity = balance + unrealised, prices with their age", async () => {
  await px.panel.open(USER_A, "ETHUSD", "Buy", 2, "click-view1");
  const v = await px.panel.accountView(USER_A, now - 3600_000);
  assert.equal(v.model.mode, "PAPER");
  assert.equal(v.model.feeRate, 0.0005);
  close(v.equity, v.balance + v.unrealisedPnl);
  assert.equal(v.prices.length, 5);
  assert.ok(v.prices.every((p) => p.ageMs === 1000));
  assert.equal(v.positions[0]!.symbol, "ETHUSD");
});

test("unsupported symbols: the instrument lookup refuses them", async () => {
  await assert.rejects(px.adapter.getInstrument("BTCUSDT"), (e: unknown) => e instanceof ExchangeError && e.kind === "unsupported_symbol");
  assert.deepEqual(await px.adapter.getInstrument("BTCUSD"), { qtyStep: 0.0001, minOrderQty: 0.0001, status: "Trading" });
});
