import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutboundAllowed, assertReduceOnlyOrder, buildTickerUrl, PaperGuardError } from "./guard.ts";

const refuses = (fn: () => unknown, code?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof PaperGuardError && (code === undefined || e.code === code));

// ---------------------------------------------------------------- outbound allowlist

test("allows exactly the public ticker and the transcription endpoint", () => {
  assertOutboundAllowed("GET", "https://www.bitstamp.net/api/v2/ticker/btcusd/");
  assertOutboundAllowed("GET", "https://www.bitstamp.net/api/v2/ticker/dogeusd/");
  assertOutboundAllowed("POST", "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(buildTickerUrl("ethusd"), "https://www.bitstamp.net/api/v2/ticker/ethusd/");
});

test("refuses the order, trading and withdrawal surface of real exchanges", () => {
  for (const url of [
    "https://api.bybit.com/v5/order/create",
    "https://api-testnet.bybit.com/v5/order/create",
    "https://api-demo.bybit.com/v5/order/create",
    "https://api.binance.com/api/v3/order",
    "https://fapi.binance.com/fapi/v1/order",
    "https://testnet.binancefuture.com/fapi/v1/order",
    "https://api.kraken.com/0/private/AddOrder",
    "https://api.kraken.com/0/private/Withdraw",
    "https://api.exchange.coinbase.com/orders",
    "https://www.okx.com/api/v5/trade/order",
    "https://www.bitstamp.net/api/v2/buy/market/btcusd/",
    "https://www.bitstamp.net/api/v2/sell/market/btcusd/",
    "https://www.bitstamp.net/api/v2/crypto-withdrawal/",
    "https://www.bitstamp.net/api/v2/balance/",
  ]) {
    for (const method of ["GET", "POST", "DELETE"]) refuses(() => assertOutboundAllowed(method, url));
  }
});

test("refuses wrong methods, unlisted pairs, and path tricks on allowed hosts", () => {
  refuses(() => assertOutboundAllowed("POST", "https://www.bitstamp.net/api/v2/ticker/btcusd/"), "method_not_allowed");
  refuses(() => assertOutboundAllowed("GET", "https://api.groq.com/openai/v1/audio/transcriptions"), "method_not_allowed");
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net/api/v2/ticker/btceur/"), "path_not_allowed");
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net/api/v2/ticker/btcusd"), "path_not_allowed");
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net/api/v2/ticker/btcusd/../../buy/market/btcusd/"), "path_not_allowed");
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net/api/v2/ticker/"), "path_not_allowed");
  refuses(() => assertOutboundAllowed("POST", "https://api.groq.com/openai/v1/chat/completions"), "path_not_allowed");
  refuses(() => buildTickerUrl("btcusd/../../buy/market/btcusd"));
});

test("refuses look-alike hosts, schemes, credentials, ports, queries and padding", () => {
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net.evil.com/api/v2/ticker/btcusd/"), "host_not_allowed");
  refuses(() => assertOutboundAllowed("GET", "https://evil-www.bitstamp.net/api/v2/ticker/btcusd/"), "host_not_allowed");
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net@evil.com/api/v2/ticker/btcusd/"));
  refuses(() => assertOutboundAllowed("GET", "http://www.bitstamp.net/api/v2/ticker/btcusd/"), "not_https");
  refuses(() => assertOutboundAllowed("GET", "https://user:pw@www.bitstamp.net/api/v2/ticker/btcusd/"), "credentials_in_url");
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net:8443/api/v2/ticker/btcusd/"), "bad_port");
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net/api/v2/ticker/btcusd/?x=1"), "bad_url");
  refuses(() => assertOutboundAllowed("GET", "https://www.bitstamp.net/api/v2/ticker/btcusd/#x"), "bad_url");
  for (const bad of [undefined, null, "", " ", 5, {}, "not a url", " https://www.bitstamp.net/api/v2/ticker/btcusd/"]) {
    refuses(() => assertOutboundAllowed("GET", bad));
  }
});

// ---------------------------------------------------------------- order shape

const goodOrder = { symbol: "BTCUSD", side: "Sell", qty: "0.25", positionIdx: 0, reduceOnly: true };

test("accepts a well-formed reduce-only order", () => {
  assertReduceOnlyOrder(goodOrder);
});

test("refuses orders that are not reduce-only or are malformed", () => {
  refuses(() => assertReduceOnlyOrder({ ...goodOrder, reduceOnly: false }), "not_reduce_only");
  refuses(() => assertReduceOnlyOrder({ ...goodOrder, reduceOnly: "true" }), "not_reduce_only");
  const { reduceOnly: _omit, ...missing } = goodOrder;
  refuses(() => assertReduceOnlyOrder(missing), "not_reduce_only");
  for (const patch of [{ symbol: "BTCUSDT" }, { symbol: "" }, { side: "buy" }, { qty: "0" }, { qty: "-1" }, { qty: 1 }, { qty: "1e3" }, { qty: "" }]) {
    refuses(() => assertReduceOnlyOrder({ ...goodOrder, ...patch }), "bad_order");
  }
  for (const bad of [null, undefined, "x", 5, []]) refuses(() => assertReduceOnlyOrder(bad), "bad_order");
});

// ---------------------------------------------------------------- source scan: no real-exchange code path

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
const files = sourceFiles(ROOT).map((p) => ({ path: relative(ROOT, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8") }));

test("source scan: the tree contains something to scan", () => {
  assert.ok(files.length >= 15, `only found ${files.length} files`);
  assert.ok(files.some((f) => f.path === "_shared/paper.ts"));
});

test("source scan: no non-test file names a real exchange's trading or withdrawal surface", () => {
  const forbidden = [
    /bybit/i, /binance/i, /\bokx\b/i, /coinbase/i, /kraken/i, /kucoin/i, /bitfinex/i, /gemini\.com/i,
    /X-BAPI/i, /\/v5\//, /AddOrder/i, /withdraw/i, /\/orders?\b/i, /api[-_ ]?secret/i, /BYBIT_/, /EXCHANGE_BASE_URL/,
  ];
  const hits: string[] = [];
  for (const f of files) for (const re of forbidden) if (re.test(f.text)) hits.push(`${f.path}: ${re}`);
  assert.deepEqual(hits, []);
});

test("source scan: every URL in non-test code points at an allowlisted host", () => {
  const allowed = new Set(OUTBOUND_HOSTS());
  const bad: string[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(/https?:\/\/([^\s/"'`)\\]+)/g)) {
      if (!allowed.has(m[1]!)) bad.push(`${f.path}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});

function OUTBOUND_HOSTS(): string[] {
  return ["www.bitstamp.net", "api.groq.com"];
}

test("source scan: network calls exist only in the two approved modules, each behind the allowlist", () => {
  const callsNetwork = (t: string) => /\bfetch\(|\bfetchFn\(|XMLHttpRequest|WebSocket|Deno\.connect|createConnection|\.connect\(/.test(t);
  const withNetwork = files.filter((f) => callsNetwork(f.text)).map((f) => f.path).sort();
  assert.deepEqual(withNetwork, ["_shared/groq.ts", "_shared/prices.ts"]);
  for (const p of withNetwork) {
    const f = files.find((x) => x.path === p)!;
    assert.match(f.text, /assertOutboundAllowed\(/, `${p} must check the allowlist before every request`);
  }
});

test("source scan: the simulated order path never imports the network layer", () => {
  const paper = files.find((f) => f.path === "_shared/paper.ts")!.text;
  assert.doesNotMatch(paper, /\bfetch\b/);
  const imports = [...paper.matchAll(/from "(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(!imports.includes("./groq.ts"));
});
