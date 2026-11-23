import { test } from "node:test";
import assert from "node:assert/strict";
import { createPriceFeed, MAX_QUOTE_AGE_MS, parseBitstampTicker, type PriceStore, type Quote, REFRESH_AFTER_MS } from "./prices.ts";
import { ExchangeError } from "./exchange.ts";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const body = (o: Record<string, unknown> = {}) => ({
  timestamp: String(NOW / 1000 - 1), last: "61084.77", bid: "61093.78", ask: "61093.79", ...o,
});

test("parses a Bitstamp ticker (all values are strings)", () => {
  const q = parseBitstampTicker("BTCUSD", body(), NOW);
  assert.deepEqual([q.symbol, q.bid, q.ask, q.last, q.sourceTs, q.fetchedAt], ["BTCUSD", 61093.78, 61093.79, 61084.77, NOW - 1000, NOW]);
});

test("rejects malformed, crossed, non-positive and frozen quotes", () => {
  for (const bad of [null, "x", {}, body({ bid: "0" }), body({ ask: "-1" }), body({ last: "abc" }), body({ timestamp: "" }), body({ bid: "2", ask: "1" })]) {
    assert.throws(() => parseBitstampTicker("BTCUSD", bad, NOW), (e: unknown) => e instanceof ExchangeError);
  }
  assert.throws(() => parseBitstampTicker("BTCUSD", body({ timestamp: String(NOW / 1000 - 600) }), NOW), (e: unknown) => e instanceof ExchangeError && e.kind === "prices_stale");
});

function setup(initial: Quote[] = []) {
  let now = NOW;
  const db = new Map(initial.map((q) => [q.symbol, q]));
  const writes: Quote[][] = [];
  const store: PriceStore = {
    async readQuotes() { return [...db.values()]; },
    async writeQuotes(qs) { writes.push(qs); for (const q of qs) db.set(q.symbol, q); },
  };
  const fetched: string[] = [];
  let mode: "ok" | "down" | "http500" | "junk" = "ok";
  const fetchFn = (async (url: string) => {
    fetched.push(url);
    if (mode === "down") throw new TypeError("offline");
    if (mode === "http500") return new Response("", { status: 500 });
    if (mode === "junk") return new Response("<html>", { status: 200 });
    return new Response(JSON.stringify({ timestamp: String(Math.floor(now / 1000)), last: "100", bid: "99.9", ask: "100.1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const feed = createPriceFeed({ store, fetchFn, now: () => now });
  return { feed, fetched, writes, db, setNow: (n: number) => (now = n), setMode: (m: typeof mode) => (mode = m), advance: (ms: number) => (now += ms) };
}

const quote = (symbol: string, fetchedAt: number): Quote => ({ symbol, bid: 99, ask: 101, last: 100, sourceTs: fetchedAt, fetchedAt });

test("cold cache fetches only the requested symbols, once each, and stores them", async () => {
  const t = setup();
  const q = await t.feed.getQuotes(["BTCUSD", "ETHUSD"]);
  assert.deepEqual([...q.keys()].sort(), ["BTCUSD", "ETHUSD"]);
  assert.equal(t.fetched.length, 2);
  assert.deepEqual(t.fetched.map((u) => u.split("/").at(-2)).sort(), ["btcusd", "ethusd"]);
  assert.equal(t.writes.length, 1);
});

test("fresh cache is served without any network call", async () => {
  const t = setup([quote("BTCUSD", NOW - 1000)]);
  await t.feed.getQuotes(["BTCUSD"]);
  assert.equal(t.fetched.length, 0);
});

test("a quote older than the refresh age is refetched", async () => {
  const t = setup([quote("BTCUSD", NOW - REFRESH_AFTER_MS - 1)]);
  await t.feed.getQuotes(["BTCUSD"]);
  assert.equal(t.fetched.length, 1);
});

test("source down: a recent cached quote is still usable, an old one fails closed as stale", async () => {
  const recent = setup([quote("BTCUSD", NOW - 6000)]);
  recent.setMode("down");
  assert.equal((await recent.feed.getQuotes(["BTCUSD"])).get("BTCUSD")!.last, 100);

  const old = setup([quote("BTCUSD", NOW - MAX_QUOTE_AGE_MS - 1)]);
  old.setMode("down");
  await assert.rejects(old.feed.getQuotes(["BTCUSD"]), (e: unknown) => e instanceof ExchangeError && e.kind === "prices_stale");
});

test("source down and nothing cached is prices_unavailable (never a made-up price)", async () => {
  for (const mode of ["down", "http500", "junk"] as const) {
    const t = setup();
    t.setMode(mode);
    await assert.rejects(t.feed.getQuotes(["BTCUSD"]), (e: unknown) => e instanceof ExchangeError && e.kind === "prices_unavailable", mode);
    assert.equal(t.writes.length, 0);
  }
});

test("if any one requested symbol has no usable quote the whole request fails closed", async () => {
  const t = setup([quote("BTCUSD", NOW - 1000)]);
  t.setMode("down");
  await assert.rejects(t.feed.getQuotes(["BTCUSD", "ETHUSD"]), (e: unknown) => e instanceof ExchangeError);
});

test("time passing makes a cached quote stale without any fetch succeeding", async () => {
  const t = setup();
  await t.feed.getQuotes(["BTCUSD"]);
  t.setMode("down");
  t.advance(10_000);
  assert.ok((await t.feed.getQuotes(["BTCUSD"])).has("BTCUSD")); // 10 s old, still within the 15 s limit
  t.advance(10_000);
  await assert.rejects(t.feed.getQuotes(["BTCUSD"]), (e: unknown) => e instanceof ExchangeError && e.kind === "prices_stale");
});

test("audit: a wildly wide spread is rejected as a broken book", () => {
  assert.throws(() => parseBitstampTicker("BTCUSD", { timestamp: String(NOW / 1000), last: "100", bid: "90", ask: "100" }, NOW), (e: unknown) => e instanceof ExchangeError);
  assert.doesNotThrow(() => parseBitstampTicker("BTCUSD", { timestamp: String(NOW / 1000), last: "100", bid: "99", ask: "101" }, NOW));
});

test("audit: a quote that jumps more than 25% from a recent one is held back; the old quote then goes stale (fail closed)", async () => {
  const t = setup([quote("BTCUSD", NOW - 5000)]);
  // the source suddenly reports a price 10x higher
  const bogus = (async () => new Response(JSON.stringify({ timestamp: String(Math.floor(NOW / 1000)), last: "1000", bid: "999.9", ask: "1000.1" }), { status: 200 })) as unknown as typeof fetch;
  const feed = createPriceFeed({ store: { readQuotes: async () => [...t.db.values()], writeQuotes: async (q) => { for (const x of q) t.db.set(x.symbol, x) } }, fetchFn: bogus, now: () => NOW });
  // cached 100 (5 s old): refresh is attempted, the bogus 1000 is refused, the recent cache still serves
  assert.equal((await feed.getQuotes(["BTCUSD"])).get("BTCUSD")!.last, 100);
  assert.equal(t.db.get("BTCUSD")!.last, 100, "the bogus quote was never stored");
  // once the cached quote is too old to use, there is no price at all
  const aged = createPriceFeed({ store: { readQuotes: async () => [quote("BTCUSD", NOW - 20_000)], writeQuotes: async () => {} }, fetchFn: bogus, now: () => NOW });
  await assert.rejects(aged.getQuotes(["BTCUSD"]), (e: unknown) => e instanceof ExchangeError);
});

test("audit: a normal move is accepted and a jump against an old cached quote (over 5 minutes) is accepted", async () => {
  const move = (async () => new Response(JSON.stringify({ timestamp: String(Math.floor(NOW / 1000)), last: "110", bid: "109.9", ask: "110.1" }), { status: 200 })) as unknown as typeof fetch;
  const db = new Map<string, Quote>([["BTCUSD", quote("BTCUSD", NOW - 6000)]]);
  const f = createPriceFeed({ store: { readQuotes: async () => [...db.values()], writeQuotes: async (q) => { for (const x of q) db.set(x.symbol, x) } }, fetchFn: move, now: () => NOW });
  assert.equal((await f.getQuotes(["BTCUSD"])).get("BTCUSD")!.last, 110);
  const far = (async () => new Response(JSON.stringify({ timestamp: String(Math.floor(NOW / 1000)), last: "500", bid: "499.9", ask: "500.1" }), { status: 200 })) as unknown as typeof fetch;
  const db2 = new Map<string, Quote>([["BTCUSD", quote("BTCUSD", NOW - 10 * 60_000)]]);
  const f2 = createPriceFeed({ store: { readQuotes: async () => [...db2.values()], writeQuotes: async (q) => { for (const x of q) db2.set(x.symbol, x) } }, fetchFn: far, now: () => NOW });
  assert.equal((await f2.getQuotes(["BTCUSD"])).get("BTCUSD")!.last, 500);
});
