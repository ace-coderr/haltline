import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, USER_A, USER_B } from "./db.ts";

let db: PGlite;
const FEE = 0.0005;
type R = Record<string, any>;

const fill = async (
  user: string, symbol: string, side: "Buy" | "Sell", qty: number, price: number,
  o: { reduceOnly?: boolean; link?: string | null; marks?: Record<string, number>; lev?: number; source?: string } = {},
): Promise<R> =>
  ((await db.query<{ r: R }>(
    "select paper_apply_fill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) as r",
    [user, symbol, side, qty, price, FEE, o.reduceOnly ?? false, o.link ?? null, o.source ?? "manual", o.lev ?? 5,
      JSON.stringify(o.marks ?? { [symbol]: price })],
  )).rows[0] as { r: R }).r;

const balance = async (user = USER_A) =>
  Number(((await db.query<{ balance: string }>("select balance from paper_accounts where user_id=$1", [user])).rows[0] as { balance: string }).balance);
const position = async (symbol: string, user = USER_A) => {
  const r = (await db.query<{ side: string; size: string; entry_price: string }>(
    "select side,size,entry_price from paper_positions where user_id=$1 and symbol=$2", [user, symbol])).rows[0];
  return r ? { side: r.side, size: Number(r.size), entry: Number(r.entry_price) } : null;
};
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

before(async () => { db = await createDb(); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.exec("truncate paper_fills, paper_positions, paper_accounts cascade"); });

test("first fill creates a 10,000 account, opens the position and charges the fee", async () => {
  const r = await fill(USER_A, "BTCUSD", "Buy", 0.1, 60000);
  assert.equal(r.ok, true);
  close(r.fee, 0.1 * 60000 * FEE);
  close(await balance(), 10000 - 3);
  assert.deepEqual(await position("BTCUSD"), { side: "Buy", size: 0.1, entry: 60000 });
});

test("adding to a position averages the entry price", async () => {
  await fill(USER_A, "BTCUSD", "Buy", 1, 100);
  await fill(USER_A, "BTCUSD", "Buy", 3, 200);
  const p = (await position("BTCUSD"))!;
  close(p.size, 4);
  close(p.entry, 175);
});

test("partial close of a long realises PnL on the closed part only", async () => {
  await fill(USER_A, "ETHUSD", "Buy", 2, 1000);
  const r = await fill(USER_A, "ETHUSD", "Sell", 0.5, 1100, { reduceOnly: true });
  close(r.realized_pnl, 50);
  const p = (await position("ETHUSD"))!;
  assert.deepEqual([p.side, p.size, p.entry], ["Buy", 1.5, 1000]);
  close(await balance(), 10000 - 2 * 1000 * FEE + 50 - 0.5 * 1100 * FEE);
});

test("short: profit when the price falls, full close removes the position", async () => {
  await fill(USER_A, "SOLUSD", "Sell", 10, 100);
  const r = await fill(USER_A, "SOLUSD", "Buy", 10, 90, { reduceOnly: true });
  close(r.realized_pnl, 100);
  assert.equal(await position("SOLUSD"), null);
  assert.equal(r.position, null);
});

test("a non-reduce-only opposite fill larger than the position flips it", async () => {
  await fill(USER_A, "BTCUSD", "Buy", 1, 100);
  const r = await fill(USER_A, "BTCUSD", "Sell", 3, 110);
  close(r.realized_pnl, 10);
  const p = (await position("BTCUSD"))!;
  assert.deepEqual([p.side, p.size, p.entry], ["Sell", 2, 110]);
});

test("reduce-only is refused with no position, the wrong side, or too much size", async () => {
  assert.equal((await fill(USER_A, "BTCUSD", "Sell", 1, 100, { reduceOnly: true })).reason, "reduce_only_no_position");
  await fill(USER_A, "BTCUSD", "Buy", 1, 100);
  assert.equal((await fill(USER_A, "BTCUSD", "Buy", 1, 100, { reduceOnly: true })).reason, "reduce_only_wrong_side");
  assert.equal((await fill(USER_A, "BTCUSD", "Sell", 1.0001, 100, { reduceOnly: true })).reason, "reduce_only_exceeds_position");
  assert.deepEqual(await position("BTCUSD"), { side: "Buy", size: 1, entry: 100 });
});

test("property: a successful reduce-only fill never increases exposure or flips", async () => {
  await fill(USER_A, "BTCUSD", "Buy", 5, 100);
  let size = 5;
  for (const q of [0.3, 1.7, 0.001, 2, 9, 0.5, 100]) {
    const r = await fill(USER_A, "BTCUSD", "Sell", q, 100, { reduceOnly: true });
    const p = await position("BTCUSD");
    if (r.ok) {
      assert.ok(p === null || (p.side === "Buy" && p.size < size));
      size = p?.size ?? 0;
    } else {
      assert.equal(p?.size ?? 0, size);
    }
    if (!p) break;
  }
});

test("the same link_id is applied once (double click / retry safe)", async () => {
  const a = await fill(USER_A, "BTCUSD", "Buy", 0.1, 60000, { link: "click-1" });
  const b = await fill(USER_A, "BTCUSD", "Buy", 0.1, 60000, { link: "click-1" });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.fill_id, a.fill_id);
  close((await position("BTCUSD"))!.size, 0.1);
  close(await balance(), 10000 - 3);
  // the same link_id for another user is independent
  assert.equal((await fill(USER_B, "BTCUSD", "Buy", 0.1, 60000, { link: "click-1" })).duplicate, false);
});

test("margin: notional above 5x equity is refused, within limit is accepted", async () => {
  assert.equal((await fill(USER_A, "BTCUSD", "Buy", 1, 60000)).reason, "insufficient_margin"); // 60k > 5 x ~10k
  assert.equal((await fill(USER_A, "BTCUSD", "Buy", 0.8, 60000)).ok, true); // 48k
  assert.equal((await fill(USER_A, "BTCUSD", "Buy", 0.1, 60000)).reason, "insufficient_margin"); // 54k
});

test("margin uses marks of other positions and fails closed without one", async () => {
  await fill(USER_A, "BTCUSD", "Buy", 0.5, 60000);
  const missing = await fill(USER_A, "ETHUSD", "Buy", 1, 1700, { marks: { ETHUSD: 1700 } }); // no BTC mark
  assert.deepEqual([missing.ok, missing.reason], [false, "no_mark"]);
  const ok = await fill(USER_A, "ETHUSD", "Buy", 1, 1700, { marks: { ETHUSD: 1700, BTCUSD: 60000 } });
  assert.equal(ok.ok, true);
  // unrealised loss on BTC reduces equity and therefore capacity
  const bad = await fill(USER_A, "ETHUSD", "Buy", 15, 1700, { marks: { ETHUSD: 1700, BTCUSD: 30000 } });
  assert.equal(bad.reason, "insufficient_margin");
});

test("reducing fills are never blocked by the margin check, even at negative equity", async () => {
  await fill(USER_A, "BTCUSD", "Buy", 0.8, 60000);
  const r = await fill(USER_A, "BTCUSD", "Sell", 0.8, 20000, { reduceOnly: true, marks: { BTCUSD: 20000 } });
  assert.equal(r.ok, true);
  assert.ok((await balance()) < 0);
  assert.equal(await position("BTCUSD"), null);
});

test("invalid parameters raise instead of being coerced", async () => {
  const bad: [string, any[]][] = [
    ["qty zero", ["BTCUSD", "Buy", 0, 100]],
    ["negative price", ["BTCUSD", "Buy", 1, -5]],
    ["bad side", ["BTCUSD", "Hold", 1, 100]],
    ["bad symbol", ["btc/usd", "Buy", 1, 100]],
  ];
  for (const [name, a] of bad) await assert.rejects(fill(USER_A, a[0], a[1], a[2], a[3]), Error, name);
  await assert.rejects(db.query("select paper_apply_fill($1,'BTCUSD','Buy',1,100,0.5,false,null,'manual',5,'{}'::jsonb)", [USER_A]), Error, "fee too high");
  await assert.rejects(db.query("select paper_apply_fill($1,'BTCUSD','Buy',1,100,0.0005,false,null,'bot',5,'{}'::jsonb)", [USER_A]), Error, "bad source");
});

test("paper_realized_since is net of fees and respects the time window", async () => {
  await fill(USER_A, "BTCUSD", "Buy", 1, 100);
  await fill(USER_A, "BTCUSD", "Sell", 1, 90, { reduceOnly: true });
  const net = Number((await db.query<{ v: string }>("select paper_realized_since($1, now() - interval '1 day') as v", [USER_A])).rows[0]!.v);
  close(net, -10 - 100 * FEE - 90 * FEE);
  const none = Number((await db.query<{ v: string }>("select paper_realized_since($1, now() + interval '1 day') as v", [USER_A])).rows[0]!.v);
  assert.equal(none, 0);
  const other = Number((await db.query<{ v: string }>("select paper_realized_since($1, now() - interval '1 day') as v", [USER_B])).rows[0]!.v);
  assert.equal(other, 0);
});

test("reset is refused with open positions and keeps fill history", async () => {
  await fill(USER_A, "BTCUSD", "Buy", 0.1, 60000);
  const refused = (await db.query<{ r: R }>("select paper_reset($1, 10000) as r", [USER_A])).rows[0]!.r;
  assert.deepEqual([refused.ok, refused.reason], [false, "has_positions"]);
  await fill(USER_A, "BTCUSD", "Sell", 0.1, 59000, { reduceOnly: true });
  const ok = (await db.query<{ r: R }>("select paper_reset($1, 10000) as r", [USER_A])).rows[0]!.r;
  assert.equal(ok.ok, true);
  close(await balance(), 10000);
  const n = Number((await db.query<{ c: number }>("select count(*)::int as c from paper_fills where user_id=$1", [USER_A])).rows[0]!.c);
  assert.equal(n, 2, "history is kept");
  const net = Number((await db.query<{ v: string }>("select paper_realized_since($1, now() - interval '1 day') as v", [USER_A])).rows[0]!.v);
  assert.ok(net < -100, "a reset must not erase today's loss from the daily limit");
});

const asRole = async (role: string, sub: string | null, fn: () => Promise<void>) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${sub ?? ""}', false); set role ${role};`);
  try { await fn(); } finally { await db.exec("reset role;"); }
};

test("RLS: own paper rows readable, others hidden, no client writes, prices are public", async () => {
  await fill(USER_A, "BTCUSD", "Buy", 0.1, 60000);
  await fill(USER_B, "ETHUSD", "Buy", 1, 1700);
  await db.query("insert into paper_prices (symbol,bid,ask,last,source_ts,source) values ('BTCUSD',1,2,1.5,now(),'bitstamp')");
  await asRole("authenticated", USER_A, async () => {
    for (const t of ["paper_accounts", "paper_positions", "paper_fills"]) {
      const rows = (await db.query<{ user_id: string }>(`select user_id from ${t}`)).rows;
      assert.ok(rows.length >= 1 && rows.every((r) => r.user_id === USER_A), t);
    }
    await assert.rejects(db.query("update paper_accounts set balance = 1e9"), Error);
    await assert.rejects(db.query("insert into paper_fills (user_id,symbol,side,qty,price,fee,realized_pnl,reduce_only,source) values ($1,'X','Buy',1,1,0,0,false,'manual')", [USER_A]));
    await assert.rejects(db.query("delete from paper_positions"), Error);
    await assert.rejects(db.query("insert into paper_prices (symbol,bid,ask,last,source_ts,source) values ('ETHUSD',1,2,1,now(),'x')"), Error);
    await assert.rejects(db.query("select paper_apply_fill($1,'BTCUSD','Buy',1,1,0.0005,false,null,'manual',5,'{}'::jsonb)", [USER_A]), Error);
    await assert.rejects(db.query("select paper_reset($1, 1e9)", [USER_A]), Error);
  });
  await asRole("anon", null, async () => {
    assert.equal((await db.query("select * from paper_prices")).rows.length, 1);
    for (const t of ["paper_accounts", "paper_positions", "paper_fills"]) await assert.rejects(db.query(`select * from ${t}`), Error, t);
    await assert.rejects(db.query("insert into paper_prices (symbol,bid,ask,last,source_ts,source) values ('ETHUSD',1,2,1,now(),'x')"), Error);
  });
});
