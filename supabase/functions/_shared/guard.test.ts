import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedEndpoint,
  assertReduceOnlyOrderBody,
  assertTestnetBaseUrl,
  buildExchangeRequest,
  TESTNET_ORIGIN,
  TestnetGuardError,
} from "./guard.ts";

const refuses = (fn: () => unknown, code?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof TestnetGuardError && (code === undefined || e.code === code));

test("accepts the Bybit testnet origin", () => {
  assert.equal(assertTestnetBaseUrl("https://api-testnet.bybit.com"), TESTNET_ORIGIN);
  assert.equal(assertTestnetBaseUrl("https://api-testnet.bybit.com/"), TESTNET_ORIGIN);
  assert.equal(assertTestnetBaseUrl("https://API-TESTNET.bybit.com"), TESTNET_ORIGIN);
  assert.equal(assertTestnetBaseUrl("https://api-testnet.bybit.com:443"), TESTNET_ORIGIN);
});

test("refuses mainnet hosts", () => {
  for (const url of [
    "https://api.bybit.com",
    "https://api.bytick.com",
    "https://api.bybit.eu",
    "https://api.bybit.kz",
    "https://api.bybit.tr",
    "https://api.bybit.ae",
    "https://bybit.com",
  ]) {
    refuses(() => assertTestnetBaseUrl(url), "not_testnet");
  }
});

test("refuses Demo Trading (production infrastructure) and other testnet-lookalikes", () => {
  for (const url of [
    "https://api-demo.bybit.com",
    "https://api-testnet.bybit.com.evil.com",
    "https://evil-api-testnet.bybit.com",
    "https://testnet.bybit.com",
    "https://api-testnet.bybit.co",
    "https://api-testnet.bybit.com.",
    "https://api.binance.com",
    "https://testnet.binancefuture.com",
  ]) {
    refuses(() => assertTestnetBaseUrl(url), "not_testnet");
  }
});

test("refuses URL tricks that resolve to a different host", () => {
  // userinfo trick: real host is api.bybit.com
  refuses(() => assertTestnetBaseUrl("https://api-testnet.bybit.com@api.bybit.com"));
  refuses(() => assertTestnetBaseUrl("https://api-testnet.bybit.com:pw@api.bybit.com"));
  // backslash is treated as a slash by the URL parser: host stays testnet but path is junk
  refuses(() => assertTestnetBaseUrl("https://api-testnet.bybit.com\\@api.bybit.com"), "bad_path");
  refuses(() => assertTestnetBaseUrl("https://api.bybit.com#@api-testnet.bybit.com"), "not_testnet");
  refuses(() => assertTestnetBaseUrl("https://api.bybit.com?x=api-testnet.bybit.com"), "not_testnet");
});

test("refuses non-https, credentials, ports, paths, queries and fragments", () => {
  refuses(() => assertTestnetBaseUrl("http://api-testnet.bybit.com"), "not_https");
  refuses(() => assertTestnetBaseUrl("ws://api-testnet.bybit.com"), "not_https");
  refuses(() => assertTestnetBaseUrl("https://user:pw@api-testnet.bybit.com"), "credentials_in_url");
  refuses(() => assertTestnetBaseUrl("https://api-testnet.bybit.com:8443"), "bad_port");
  refuses(() => assertTestnetBaseUrl("https://api-testnet.bybit.com/v5"), "bad_path");
  refuses(() => assertTestnetBaseUrl("https://api-testnet.bybit.com/?a=b"), "bad_path");
  refuses(() => assertTestnetBaseUrl("https://api-testnet.bybit.com/#x"), "bad_path");
});

test("refuses missing, empty, non-string and padded values", () => {
  for (const bad of [undefined, null, "", " ", 42, {}, [], "not a url", " https://api-testnet.bybit.com", "https://api-testnet.bybit.com\n"]) {
    refuses(() => assertTestnetBaseUrl(bad));
  }
});

test("buildExchangeRequest uses only the testnet origin and keeps the query order", () => {
  const r = buildExchangeRequest("https://api-testnet.bybit.com", "GET", "/v5/position/list", {
    category: "linear",
    settleCoin: "USDT",
  });
  assert.equal(r.url, "https://api-testnet.bybit.com/v5/position/list?category=linear&settleCoin=USDT");
  assert.equal(r.queryString, "category=linear&settleCoin=USDT");
  const noQuery = buildExchangeRequest("https://api-testnet.bybit.com", "POST", "/v5/order/create");
  assert.equal(noQuery.url, "https://api-testnet.bybit.com/v5/order/create");
  assert.equal(noQuery.queryString, "");
});

test("buildExchangeRequest refuses a mainnet base even for an allowed endpoint", () => {
  refuses(() => buildExchangeRequest("https://api.bybit.com", "GET", "/v5/position/list"), "not_testnet");
  refuses(() => buildExchangeRequest(undefined, "GET", "/v5/position/list"));
});

test("endpoint allowlist excludes withdrawals, transfers and key management", () => {
  for (const [m, p] of [
    ["POST", "/v5/asset/withdraw/create"],
    ["POST", "/v5/asset/transfer/inter-transfer"],
    ["POST", "/v5/asset/transfer/universal-transfer"],
    ["GET", "/v5/user/query-api"],
    ["POST", "/v5/user/update-api"],
    ["POST", "/v5/order/cancel-all"],
    ["POST", "/v5/position/set-leverage"],
    ["GET", "/v5/order/create"],
    ["POST", "/v5/position/list"],
    ["GET", "/v5/position/list/"],
    ["GET", "/v5/position/list/../asset/withdraw/create"],
  ] as const) {
    refuses(() => assertAllowedEndpoint(m, p), "endpoint_not_allowed");
  }
  assertAllowedEndpoint("GET", "/v5/position/closed-pnl");
});

const goodOrder = {
  category: "linear",
  symbol: "BTCUSDT",
  side: "Sell",
  orderType: "Market",
  qty: "0.250",
  reduceOnly: true,
  positionIdx: 0,
};

test("accepts a well-formed reduce-only order", () => {
  assertReduceOnlyOrderBody(goodOrder);
});

test("refuses any order that is not reduce-only", () => {
  refuses(() => assertReduceOnlyOrderBody({ ...goodOrder, reduceOnly: false }), "not_reduce_only");
  refuses(() => assertReduceOnlyOrderBody({ ...goodOrder, reduceOnly: "true" }), "not_reduce_only");
  const { reduceOnly: _omit, ...missing } = goodOrder;
  refuses(() => assertReduceOnlyOrderBody(missing), "not_reduce_only");
});

test("refuses malformed orders", () => {
  for (const patch of [
    { category: "spot" },
    { category: "inverse" },
    { orderType: "StopMarket" },
    { side: "buy" },
    { symbol: "btcusdt" },
    { symbol: "BTC/USDT" },
    { qty: "0" },
    { qty: "-1" },
    { qty: 1 },
    { qty: "1e3" },
    { qty: "" },
  ]) {
    refuses(() => assertReduceOnlyOrderBody({ ...goodOrder, ...patch }), "bad_order");
  }
  for (const bad of [null, undefined, "x", 5, []]) refuses(() => assertReduceOnlyOrderBody(bad), "bad_order");
});
