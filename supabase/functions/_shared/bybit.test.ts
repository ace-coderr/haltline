import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BybitError, createBybitClient, hmacSha256Hex } from "./bybit.ts";
import { TestnetGuardError } from "./guard.ts";
import type { PlannedOrder } from "./actions.ts";

const BASE = "https://api-testnet.bybit.com";
const KEY = "test-key";
const SECRET = "test-secret";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
type Responder = (call: Call, n: number) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ retCode: 0, retMsg: "OK", result, time: 1 });

function harness(responder: Responder) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    };
    calls.push(call);
    return responder(call, calls.length);
  }) as unknown as typeof fetch;
  const client = createBybitClient({
    baseUrl: BASE,
    apiKey: KEY,
    apiSecret: SECRET,
    fetchFn,
    nowMs: () => 1_700_000_000_000,
    sleep: async () => {},
  });
  return { client, calls };
}

test("hmacSha256Hex matches Node's independent HMAC", async () => {
  const msg = "1658384314791XXXXXXXXXX5000category=option&symbol=BTC-29JUL22-25000-C";
  assert.equal(await hmacSha256Hex("secret", msg), createHmac("sha256", "secret").update(msg).digest("hex"));
});

test("construction refuses mainnet and missing credentials", () => {
  for (const baseUrl of ["https://api.bybit.com", "https://api-demo.bybit.com", undefined]) {
    assert.throws(
      () => createBybitClient({ baseUrl, apiKey: KEY, apiSecret: SECRET }),
      (e: unknown) => e instanceof TestnetGuardError,
    );
  }
  assert.throws(() => createBybitClient({ baseUrl: BASE, apiKey: "", apiSecret: SECRET }), BybitError);
  assert.throws(() => createBybitClient({ baseUrl: BASE, apiKey: KEY, apiSecret: "" }), BybitError);
});

test("GET is signed over timestamp + key + recvWindow + queryString", async () => {
  const { client, calls } = harness(() => ok({ list: [], nextPageCursor: "" }));
  await client.getPositions();
  const c = calls[0]!;
  assert.equal(c.url, `${BASE}/v5/position/list?category=linear&settleCoin=USDT&limit=200`);
  assert.equal(c.headers["X-BAPI-API-KEY"], KEY);
  assert.equal(c.headers["X-BAPI-TIMESTAMP"], "1700000000000");
  assert.equal(c.headers["X-BAPI-RECV-WINDOW"], "5000");
  const expected = createHmac("sha256", SECRET)
    .update("1700000000000" + KEY + "5000" + "category=linear&settleCoin=USDT&limit=200")
    .digest("hex");
  assert.equal(c.headers["X-BAPI-SIGN"], expected);
  assert.equal(c.method, "GET");
  assert.equal(c.body, undefined);
});

test("positions: parses strings, drops empty positions, follows the cursor", async () => {
  const pages = [
    ok({
      list: [
        { symbol: "BTCUSDT", side: "Buy", size: "0.5", positionIdx: 0, avgPrice: "60000", markPrice: "59000", unrealisedPnl: "-500" },
        { symbol: "ETHUSDT", side: "", size: "0", positionIdx: 0, avgPrice: "0", markPrice: "3000", unrealisedPnl: "0" },
      ],
      nextPageCursor: "next1",
    }),
    ok({
      list: [{ symbol: "SOLUSDT", side: "Sell", size: "10", positionIdx: 0, avgPrice: "150", markPrice: "149", unrealisedPnl: "10" }],
      nextPageCursor: "",
    }),
  ];
  const { client, calls } = harness((_c, n) => pages[n - 1]!);
  const p = await client.getPositions();
  assert.deepEqual(p.map((x) => [x.symbol, x.side, x.size, x.unrealisedPnl]), [
    ["BTCUSDT", "Buy", 0.5, -500],
    ["SOLUSDT", "Sell", 10, 10],
  ]);
  assert.match(calls[1]!.url, /cursor=next1/);
});

test("positions: malformed data fails closed instead of being guessed", async () => {
  for (const bad of [
    { symbol: "BTCUSDT", side: "Buy", size: "abc", positionIdx: 0, avgPrice: "1", markPrice: "1", unrealisedPnl: "0" },
    { symbol: "BTCUSDT", side: "Long", size: "1", positionIdx: 0, avgPrice: "1", markPrice: "1", unrealisedPnl: "0" },
    { symbol: "BTCUSDT", side: "Buy", size: "1", positionIdx: 7, avgPrice: "1", markPrice: "1", unrealisedPnl: "0" },
    { symbol: "BTCUSDT", side: "Buy", size: "1", positionIdx: 0, avgPrice: "1", markPrice: "1", unrealisedPnl: "" },
  ]) {
    const { client } = harness(() => ok({ list: [bad], nextPageCursor: "" }));
    await assert.rejects(client.getPositions(), (e: unknown) => e instanceof BybitError && e.kind === "bad_response");
  }
});

test("closed PnL sums across pages and rejects oversized windows", async () => {
  const pages = [
    ok({ list: [{ closedPnl: "-12.5" }, { closedPnl: "3.1" }], nextPageCursor: "c" }),
    ok({ list: [{ closedPnl: "-0.6" }], nextPageCursor: "" }),
  ];
  const { client, calls } = harness((_c, n) => pages[n - 1]!);
  const t0 = Date.UTC(2026, 10, 23);
  assert.equal(await client.getClosedPnl(t0, t0 + 3600_000), -10);
  assert.match(calls[0]!.url, /startTime=\d+&endTime=\d+&limit=100/);
  await assert.rejects(client.getClosedPnl(t0, t0 + 8 * 24 * 3600_000), RangeError);
  await assert.rejects(client.getClosedPnl(t0, t0), RangeError);
});

test("equity and instrument parsing", async () => {
  const { client } = harness((c) =>
    c.url.includes("wallet-balance")
      ? ok({ list: [{ totalEquity: "10234.56" }] })
      : ok({ list: [{ symbol: "BTCUSDT", status: "Trading", lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", maxMktOrderQty: "500.000" } }] }),
  );
  assert.deepEqual(await client.getEquity(), { totalEquity: 10234.56 });
  assert.deepEqual(await client.getInstrument("BTCUSDT"), {
    qtyStep: 0.001,
    minOrderQty: 0.001,
    maxMktOrderQty: 500,
    status: "Trading",
  });
});

test("instrument lookup rejects a mismatched symbol", async () => {
  const { client } = harness(() => ok({ list: [{ symbol: "ETHUSDT", lotSizeFilter: { qtyStep: "1", minOrderQty: "1", maxMktOrderQty: "1" } }] }));
  await assert.rejects(client.getInstrument("BTCUSDT"), BybitError);
});

const order: PlannedOrder = { symbol: "BTCUSDT", side: "Sell", qty: "0.250", positionIdx: 0, reduceOnly: true };

test("order: POST is signed over the exact JSON body and is reduce-only", async () => {
  const { client, calls } = harness(() => ok({ orderId: "o-1", orderLinkId: "hl-abc-0" }));
  const r = await client.placeReduceOnlyMarket(order, "hl-abc-0");
  assert.deepEqual(r, { orderId: "o-1", orderLinkId: "hl-abc-0" });
  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, `${BASE}/v5/order/create`);
  const body = JSON.parse(c.body!);
  assert.equal(body.reduceOnly, true);
  assert.equal(body.category, "linear");
  assert.equal(body.orderType, "Market");
  assert.equal(body.side, "Sell");
  assert.equal(body.qty, "0.250");
  const expected = createHmac("sha256", SECRET).update("1700000000000" + KEY + "5000" + c.body!).digest("hex");
  assert.equal(c.headers["X-BAPI-SIGN"], expected);
  assert.equal(c.headers["Content-Type"], "application/json");
});

test("order: invalid orderLinkId, symbol or qty never leave the process", async () => {
  const { client, calls } = harness(() => ok({ orderId: "x" }));
  await assert.rejects(client.placeReduceOnlyMarket(order, "bad id!"), RangeError);
  for (const bad of [{ symbol: "btc/usdt" }, { qty: "0" }, { qty: "-1" }, { qty: "1e3" }, { side: "Hold" }]) {
    await assert.rejects(
      client.placeReduceOnlyMarket({ ...order, ...bad } as unknown as PlannedOrder, "ok-1"),
      (e: unknown) => e instanceof TestnetGuardError,
    );
  }
  assert.equal(calls.length, 0);
});

test("order: reduceOnly is always true on the wire, whatever the plan object says", async () => {
  const { client, calls } = harness(() => ok({ orderId: "x" }));
  await client.placeReduceOnlyMarket({ ...order, reduceOnly: false } as unknown as PlannedOrder, "ok-1");
  assert.equal(JSON.parse(calls[0]!.body!).reduceOnly, true);
});

test("order: a transport failure is NOT retried (no accidental double order)", async () => {
  const { client, calls } = harness(() => {
    throw new TypeError("network down");
  });
  await assert.rejects(client.placeReduceOnlyMarket(order, "hl-1"), (e: unknown) => e instanceof BybitError && e.kind === "network");
  assert.equal(calls.length, 1);
});

test("order: exchange rejection surfaces the retCode", async () => {
  const { client } = harness(() => json({ retCode: 110017, retMsg: "orderQty will be truncated to zero", result: {} }));
  await assert.rejects(
    client.placeReduceOnlyMarket(order, "hl-1"),
    (e: unknown) => e instanceof BybitError && e.kind === "exchange" && e.retCode === 110017,
  );
});

test("GET retries transient failures up to twice, then gives up", async () => {
  const { client, calls } = harness((_c, n) => (n < 3 ? json({ retCode: 10006, retMsg: "Too many visits!" }) : ok({ timeNano: "1688639403423213947" })));
  assert.equal(await client.serverTimeMs(), 1688639403423);
  assert.equal(calls.length, 3);

  const h2 = harness(() => json({ retCode: 10006, retMsg: "Too many visits!" }));
  await assert.rejects(h2.client.serverTimeMs(), (e: unknown) => e instanceof BybitError && e.kind === "rate_limited");
  assert.equal(h2.calls.length, 3);
});

test("GET does not retry auth errors", async () => {
  const { client, calls } = harness(() => json({ retCode: 10003, retMsg: "API key is invalid." }));
  await assert.rejects(client.getEquity(), (e: unknown) => e instanceof BybitError && e.kind === "auth");
  assert.equal(calls.length, 1);
});

test("error mapping: 403 region block, 429, clock, non-JSON, missing retCode", async () => {
  const kinds: [Response, string][] = [
    [new Response("", { status: 403 }), "region_blocked"],
    [new Response("", { status: 429 }), "rate_limited"],
    [json({ retCode: 10002, retMsg: "time window" }), "clock"],
    [json({ retCode: 10004, retMsg: "sign" }), "auth"],
    [json({ retCode: 10009, retMsg: "region" }), "region_blocked"],
    [new Response("<html>", { status: 502 }), "bad_response"],
    [json({ result: {} }), "bad_response"],
  ];
  for (const [res, kind] of kinds) {
    const { client } = harness(() => res.clone());
    // use a one-shot call that does not retry: order placement
    await assert.rejects(
      client.placeReduceOnlyMarket(order, "hl-1"),
      (e: unknown) => e instanceof BybitError && e.kind === kind,
      kind,
    );
  }
});
