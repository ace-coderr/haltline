// Hostile audit against the DEPLOYED backend. Run: node scripts/audit-live.ts
// Creates two throwaway anonymous users and attacks the API the way a malicious or buggy client would.
// Every line is PASS (the system held) or FAIL (a hole). Never prints tokens or keys.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

function env(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const m = readFileSync(new URL("../../web/.env", import.meta.url), "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  if (!m) throw new Error(`missing ${name}`);
  return m[1]!.trim();
}
const URL_ = env("VITE_SUPABASE_URL");
const KEY = env("VITE_SUPABASE_ANON_KEY");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    failures.push(name);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

type J = Record<string, any>;
interface Res { status: number; json: J; headers: Headers }

async function raw(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Res> {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${URL_}${path}`, { ...init, headers: { apikey: KEY, ...(init.headers ?? {}) } });
      let json: J = {};
      try { json = (await res.json()) as J; } catch { /* not JSON */ }
      return { status: res.status, json, headers: res.headers };
    } catch (e) {
      if (i === 3) throw e;
      await sleep(3000);
    }
  }
  throw new Error("unreachable");
}

const fn = (name: string, o: { method?: string; body?: unknown; bearer?: string | null; device?: string | null; headers?: Record<string, string>; rawBody?: BodyInit; ct?: string } = {}) => {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.device) headers["x-device-token"] = o.device;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.ct) headers["content-type"] = o.ct;
  return raw(`/functions/v1/${name}`, {
    method: o.method ?? (o.body !== undefined || o.rawBody !== undefined ? "POST" : "GET"),
    headers,
    body: o.rawBody !== undefined ? o.rawBody : o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
};
const rest = (path: string, bearer?: string | null, init: RequestInit = {}) =>
  raw(`/rest/v1/${path}`, { ...init, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...((init.headers as Record<string, string>) ?? {}) } });

async function newUser(): Promise<{ jwt: string; id: string }> {
  const r = await raw("/auth/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.json.access_token) throw new Error(`could not create a test user: ${r.status} ${r.json.error_code ?? ""}`);
  return { jwt: r.json.access_token as string, id: (r.json.user as J).id as string };
}
async function pairDevice(user: { jwt: string }): Promise<string> {
  const s = await fn("pair", { body: { action: "start" } });
  await fn("pair", { body: { action: "claim", code: s.json.code }, bearer: user.jwt });
  const p = await fn("pair", { body: { action: "poll" }, device: s.json.token });
  if (p.json.status !== "paired") throw new Error("pairing failed in audit setup");
  return s.json.token as string;
}
const cid = () => randomUUID().replace(/-/g, "").slice(0, 24);

async function main() {
  const A = await newUser();
  const B = await newUser();
  const devA = await pairDevice(A);

  // ---------------------------------------------------------------- authentication
  console.log("\n# authentication and sessions");
  for (const [label, o] of [
    ["no credentials", {}],
    ["garbage bearer", { bearer: "not.a.jwt" }],
    ["expired-looking JWT", { bearer: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.AAAA" }],
    ["publishable key used as bearer", { bearer: KEY }],
    ["bearer with no token", { headers: { authorization: "Bearer " } }],
    ["device token too short", { device: "abc" }],
    ["device token with quotes (SQL-ish)", { device: "' OR '1'='1" + "x".repeat(40) }],
    ["well-formed but unknown device token", { device: "a".repeat(43) }],
    ["device token AND garbage bearer (device wins, still unknown)", { device: "b".repeat(43), bearer: "x.y.z" }],
  ] as [string, J][]) {
    const r = await fn("positions", o);
    check(`401 for ${label}`, r.status === 401, `HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- RLS through the REST API
  console.log("\n# row level security (REST)");
  for (const t of ["limits", "actions_log", "paper_fills", "paper_accounts", "paper_positions", "devices", "sessions", "proposals", "pairing_codes", "pairing_attempts"]) {
    const r = await rest(`${t}?select=*&limit=1`, null);
    check(`anonymous cannot read ${t}`, r.status === 401 || r.status === 403 || (Array.isArray(r.json) && r.json.length === 0), `HTTP ${r.status}`);
  }
  const prices = await rest("paper_prices?select=symbol,bid&limit=1", null);
  check("price cache is public (public market data)", prices.status === 200 && Array.isArray(prices.json));
  for (const t of ["proposals", "pairing_codes", "pairing_attempts"]) {
    const r = await rest(`${t}?select=*`, A.jwt);
    check(`signed-in user cannot read server-only table ${t}`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  }
  const hashes = await rest("devices?select=token_hash", A.jwt);
  check("token_hash column is not readable", hashes.status === 401 || hashes.status === 403, `HTTP ${hashes.status}`);
  const upd = await rest(`limits?user_id=eq.${A.id}`, A.jwt, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=representation" }, body: JSON.stringify({ daily_limit: 999999, kill_switch: false }) });
  check("user cannot write limits directly", upd.status === 401 || upd.status === 403, `HTTP ${upd.status}`);
  const ins = await rest("actions_log", A.jwt, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_id: A.id, kind: "dismiss", status: "executed" }) });
  check("user cannot forge actions log rows", ins.status === 401 || ins.status === 403, `HTTP ${ins.status}`);
  const fill = await rest("paper_fills", A.jwt, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_id: A.id, symbol: "BTCUSD", side: "Buy", qty: 1, price: 1, fee: 0, realized_pnl: 1e9, reduce_only: false, source: "manual" }) });
  check("user cannot forge fills or PnL", fill.status === 401 || fill.status === 403, `HTTP ${fill.status}`);
  const bal = await rest(`paper_accounts?user_id=eq.${A.id}`, A.jwt, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ balance: 1e12 }) });
  check("user cannot set their own paper balance", bal.status === 401 || bal.status === 403 || bal.status === 404, `HTTP ${bal.status}`);
  for (const f of ["claim_action_slot", "consume_proposal", "paper_apply_fill", "paper_reset", "claim_pairing_code", "redeem_pairing", "start_pairing", "paper_realized_since", "release_action_slot"]) {
    const r = await rest(`rpc/${f}`, A.jwt, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(`user cannot call internal function ${f}`, r.status === 401 || r.status === 403 || r.status === 404, `HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- bad inputs
  console.log("\n# malformed and hostile inputs");
  const bigBody = await fn("limits", { rawBody: JSON.stringify({ limit: 5, pad: "x".repeat(9000) }), ct: "application/json", bearer: A.jwt });
  check("oversized body is 413", bigBody.status === 413, `HTTP ${bigBody.status}`);
  check("invalid JSON is 400", (await fn("limits", { rawBody: "{nope", ct: "application/json", bearer: A.jwt })).status === 400);
  check("JSON array body is 400", (await fn("limits", { rawBody: "[1]", ct: "application/json", bearer: A.jwt })).status === 400);
  check("empty body POST is 400", (await fn("limits", { method: "POST", bearer: A.jwt })).status === 400);
  check("wrong method is 405", (await fn("positions", { method: "DELETE", bearer: A.jwt })).status === 405);

  for (const v of [0, -5, 0.5, 1e9, 1e300, "500", null, true, [], {}, 1000000.01]) {
    const r = await fn("limits", { body: { limit: v }, bearer: A.jwt });
    check(`limit ${JSON.stringify(v)} is refused`, r.status === 400 || r.status === 413, `HTTP ${r.status}`);
  }
  check("a valid limit works", (await fn("limits", { body: { limit: 500 }, bearer: A.jwt })).status === 200);
  check("limit 12.345 rounds to cents", (await fn("limits", { body: { limit: 12.345 }, bearer: A.jwt })).json.limit === 12.35);
  await fn("limits", { body: { limit: 500 }, bearer: A.jwt });

  const open = (o: J) => fn("paper", { body: { action: "open", clientId: cid(), ...o }, bearer: A.jwt });
  const bad: [string, J][] = [
    ["size 1e300", { symbol: "BTCUSD", side: "Buy", size: 1e300 }],
    ["size 1e15", { symbol: "DOGEUSD", side: "Buy", size: 1e15 }],
    ["size -1", { symbol: "BTCUSD", side: "Buy", size: -1 }],
    ["size 0", { symbol: "BTCUSD", side: "Buy", size: 0 }],
    ["size as string", { symbol: "BTCUSD", side: "Buy", size: "1" }],
    ["size null", { symbol: "BTCUSD", side: "Buy", size: null }],
    ["size array", { symbol: "BTCUSD", side: "Buy", size: [1] }],
    ["size object", { symbol: "BTCUSD", side: "Buy", size: { a: 1 } }],
    ["size below minimum", { symbol: "BTCUSD", side: "Buy", size: 1e-9 }],
    ["size off the lot step", { symbol: "BTCUSD", side: "Buy", size: 0.00015 }],
    ["symbol with SQL", { symbol: "BTCUSD'; drop table limits;--", side: "Buy", size: 0.001 }],
    ["lowercase symbol", { symbol: "btcusd", side: "Buy", size: 0.001 }],
    ["unsupported symbol", { symbol: "BTCUSDT", side: "Buy", size: 0.001 }],
    ["huge symbol string", { symbol: "A".repeat(5000), side: "Buy", size: 0.001 }],
    ["side lowercase", { symbol: "BTCUSD", side: "buy", size: 0.001 }],
    ["side long", { symbol: "BTCUSD", side: "Long", size: 0.001 }],
  ];
  for (const [label, o] of bad) {
    const r = await open(o);
    check(`open with ${label} is refused (never a 500)`, r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.json.error?.code ?? ""}`);
  }
  for (const id of [undefined, "short", "has space in it!!", "x".repeat(33), 12345678, "<script>alert(1)</script>"]) {
    const r = await fn("paper", { body: { action: "open", symbol: "BTCUSD", side: "Buy", size: 0.001, clientId: id }, bearer: A.jwt });
    check(`clientId ${JSON.stringify(id)?.slice(0, 30)} is refused`, r.status === 400, `HTTP ${r.status}`);
  }
  for (const body of [{ action: "propose", kind: "nuke" }, { action: "propose", kind: { $ne: 1 } }, { action: "confirm", proposalId: "x", kind: "cut_half" }, { action: "confirm", proposalId: randomUUID(), kind: "dismiss" }, { action: "confirm", proposalId: randomUUID(), kind: "cut_half" }, { action: "x" }, {}]) {
    const r = await fn("act", { body, bearer: A.jwt });
    check(`act ${JSON.stringify(body).slice(0, 60)} is a clean 4xx`, r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
  }
  const wav = await fn("transcribe", { rawBody: new Uint8Array(1_100_000), ct: "audio/wav", bearer: A.jwt });
  check("oversized audio is 413", wav.status === 413, `HTTP ${wav.status}`);
  check("audio with a non-audio content type is 400", (await fn("transcribe", { rawBody: "hello", ct: "text/plain", bearer: A.jwt })).status === 400);
  const junkAudio = await fn("transcribe", { rawBody: crypto.getRandomValues(new Uint8Array(4000)), ct: "audio/wav", bearer: A.jwt });
  check("random bytes sent as audio fail cleanly (no 500)", junkAudio.status >= 400 && junkAudio.status < 500, `HTTP ${junkAudio.status} ${junkAudio.json.error?.code ?? ""}`);
  const pre = await raw("/functions/v1/act", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,x-device-token" } });
  check("CORS preflight answers 204 without allowing credentials", pre.status === 204 && pre.headers.get("access-control-allow-credentials") === null, `allow-origin ${pre.headers.get("access-control-allow-origin")}`);
  const hdr = await fn("health");
  check("responses are not cacheable and nosniff", hdr.headers.get("cache-control") === "no-store" && hdr.headers.get("x-content-type-options") === "nosniff");
  check("health does not leak internals", !JSON.stringify(hdr.json).match(/service_role|password|secret|stack|postgres/i));

  // ---------------------------------------------------------------- empty account and huge positions
  console.log("\n# empty account, huge positions");
  const snap0 = await fn("positions", { bearer: B.jwt });
  check("brand-new account snapshot is honest (NO_LIMIT, no positions)", snap0.status === 200 && snap0.json.state === "NO_LIMIT" && snap0.json.positions.length === 0);
  const p0 = await fn("act", { body: { action: "propose", kind: "cut_half" }, bearer: B.jwt });
  check("cutting with no positions is a clean 409", p0.status === 409, `HTTP ${p0.status} ${p0.json.error?.code ?? ""}`);
  const huge = await fn("paper", { body: { action: "open", symbol: "BTCUSD", side: "Buy", size: 1000, clientId: cid() }, bearer: A.jwt });
  check("a position far beyond 5x equity is refused", huge.status === 409 && huge.json.error?.code === "insufficient_margin", `HTTP ${huge.status}`);
  const view = await fn("paper", { bearer: A.jwt });
  check("a refused order changes nothing (balance still 10,000)", view.json.balance === 10000 && view.json.positions.length === 0, `balance ${view.json.balance}`);

  // ---------------------------------------------------------------- double actions, cooldown bypass, idempotency, concurrency
  console.log("\n# double actions and races (real Postgres, real concurrency)");
  const key = cid();
  const burst = await Promise.all(Array.from({ length: 6 }, () => fn("paper", { body: { action: "open", symbol: "ETHUSD", side: "Buy", size: 2, clientId: key }, bearer: A.jwt })));
  const okOpen = burst.filter((r) => r.status === 200);
  const dupFlags = okOpen.filter((r) => r.json.duplicate === true).length;
  const after = await fn("paper", { bearer: A.jwt });
  check("6 parallel opens with the SAME key create exactly one fill", after.json.positions?.[0]?.size === 2 && after.json.fills.length === 1, `size ${after.json.positions?.[0]?.size}, fills ${after.json.fills.length}, ok ${okOpen.length}, duplicates ${dupFlags}`);

  await fn("limits", { body: { limit: 1 }, bearer: A.jwt }); // make it TRIPPED

  // Stray-press guard, live. The server refuses a confirm that arrives within 0.8 s of the proposal. Network
  // round trips can exceed that window, so this step accepts either outcome but never lets it skew the rest.
  const strayProp = await fn("act", { body: { action: "propose", kind: "cut_all" }, device: devA });
  const stray = await fn("act", { body: { action: "confirm", proposalId: strayProp.json.proposalId, kind: "cut_all" }, device: devA });
  if (stray.status === 425) {
    check("immediate confirm is refused as a stray press (425), and the proposal survives it", true);
    await sleep(1500);
    const retry = await fn("act", { body: { action: "confirm", proposalId: strayProp.json.proposalId, kind: "cut_all" }, device: devA });
    check("the same proposal can still be confirmed after the stray press", retry.status === 200 && retry.json.executed >= 1, `HTTP ${retry.status}`);
  } else {
    console.log(`INFO  stray-press window was exceeded by network latency (confirm answered ${stray.status}); guard covered by unit and SQL tests`);
    check("the late confirm executed once and only once", stray.status === 200 && stray.json.executed >= 1, `HTTP ${stray.status}`);
  }
  console.log("  waiting out the 60 s cooldown so the race tests start clean...");
  await sleep(61_000);
  await fn("act", { body: { action: "propose", kind: "dismiss" }, device: devA });
  const reopen = await fn("paper", { body: { action: "open", symbol: "ETHUSD", side: "Buy", size: 2, clientId: cid() }, bearer: A.jwt });
  check("account can be re-armed with a new position", reopen.status === 200, `HTTP ${reopen.status}`);
  const prop1 = await fn("act", { body: { action: "propose", kind: "cut_half" }, device: devA });
  const prop2 = await fn("act", { body: { action: "propose", kind: "cut_half" }, device: devA });
  check("two proposals can coexist", prop1.status === 200 && prop2.status === 200, `HTTP ${prop1.status}/${prop2.status}`);
  await sleep(1500);
  const racers = await Promise.all(Array.from({ length: 6 }, () => fn("act", { body: { action: "confirm", proposalId: prop1.json.proposalId, kind: "cut_half" }, device: devA })));
  const executed = racers.filter((r) => r.status === 200 && r.json.executed === 1).length;
  check("6 parallel confirms of ONE proposal execute exactly once", executed === 1, `${executed} executed; statuses ${racers.map((r) => r.status).join(",")}`);
  const second = await fn("act", { body: { action: "confirm", proposalId: prop2.json.proposalId, kind: "cut_half" }, device: devA });
  check("cooldown bypass via a second pre-made proposal is refused (429)", second.status === 429, `HTTP ${second.status} ${second.json.error?.code ?? ""}`);
  const view2 = await fn("paper", { bearer: A.jwt });
  check("the re-armed 2 ETH position was cut exactly once (to 1 ETH)", Math.abs((view2.json.positions?.[0]?.size ?? 0) - 1) < 1e-9, `size ${view2.json.positions?.[0]?.size}`);
  const guardFills = view2.json.fills.filter((f: J) => f.source === "guard");
  check("every guard fill is reduce-only", guardFills.length >= 1 && guardFills.every((f: J) => f.reduceOnly === true));

  // ---------------------------------------------------------------- cross-user isolation
  console.log("\n# cross-user isolation");
  const prop3 = await fn("act", { body: { action: "propose", kind: "cut_all" }, bearer: A.jwt });
  // A is in cooldown, so use a fresh proposal from A after the cooldown would be too slow: B tries A's earlier proposal id instead.
  const steal = await fn("act", { body: { action: "confirm", proposalId: prop2.json.proposalId, kind: "cut_half" }, bearer: B.jwt });
  check("B cannot confirm A's proposal", steal.status === 404 || steal.status === 409, `HTTP ${steal.status} ${steal.json.error?.code ?? ""}`);
  check("(A's cooldown also blocks a new proposal)", prop3.status === 429, `HTTP ${prop3.status}`);
  const rowsB = await rest("actions_log?select=id,user_id", B.jwt);
  check("B sees none of A's actions", Array.isArray(rowsB.json) && rowsB.json.every((r: J) => r.user_id === B.id));
  const fillsB = await rest("paper_fills?select=user_id", B.jwt);
  check("B sees none of A's fills", Array.isArray(fillsB.json) && fillsB.json.length === 0);
  const claimStolen = await fn("pair", { body: { action: "revoke", deviceId: randomUUID() }, bearer: B.jwt });
  check("B cannot revoke devices that are not theirs", claimStolen.status === 404);
  const devRows = await rest("devices?select=id,user_id", A.jwt);
  const devId = Array.isArray(devRows.json) && devRows.json[0]?.id;
  const stolenRevoke = await fn("pair", { body: { action: "revoke", deviceId: devId }, bearer: B.jwt });
  check("B cannot revoke A's real device", stolenRevoke.status === 404, `HTTP ${stolenRevoke.status}`);
  const killDev = await fn("limits", { body: { killSwitch: true }, device: devA });
  check("a device cannot touch the kill switch", killDev.status === 403);
  const placeDev = await fn("paper", { body: { action: "open", symbol: "ETHUSD", side: "Buy", size: 1, clientId: cid() }, device: devA });
  check("a device cannot open paper trades", placeDev.status === 403);

  // kill switch and limit-raise rule
  await fn("limits", { body: { killSwitch: true }, bearer: A.jwt });
  const killed = await fn("act", { body: { action: "propose", kind: "cut_all" }, device: devA });
  check("kill switch blocks proposals", killed.status === 403 && killed.json.error?.code === "kill_switch", `HTTP ${killed.status}`);
  await fn("limits", { body: { killSwitch: false }, bearer: A.jwt });
  const raise = await fn("limits", { body: { limit: 5000 }, device: devA });
  check("glasses cannot raise the limit while TRIPPED (403 raise_blocked)", raise.status === 403 && raise.json.error?.code === "raise_blocked", `HTTP ${raise.status} ${raise.json.error?.code ?? ""}`);
  const lower = await fn("limits", { body: { limit: 1 }, device: devA });
  check("glasses may lower the limit", lower.status === 200);

  // revoke
  const devB = await pairDevice(B);
  const rev = await fn("pair", { body: { action: "revoke", deviceId: (await rest("devices?select=id", B.jwt)).json[0].id }, bearer: B.jwt });
  check("owner can revoke a device", rev.status === 200);
  check("a revoked device token stops working at once", (await fn("positions", { device: devB })).status === 401);

  // ---------------------------------------------------------------- pairing brute force
  console.log("\n# pairing abuse");
  const C = await newUser();
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await fn("pair", { body: { action: "claim", code: String(100000 + Math.floor(Math.random() * 899999)) }, bearer: C.jwt })).status);
  check("wrong codes: 400 five times, then 429", codes.slice(0, 5).every((c) => c === 400) && codes.slice(5).every((c) => c === 429), codes.join(","));
  const s = await fn("pair", { body: { action: "start" } });
  const locked = await fn("pair", { body: { action: "claim", code: s.json.code }, bearer: C.jwt });
  check("a locked-out user cannot claim even the correct code", locked.status === 429, `HTTP ${locked.status}`);
  const ok = await fn("pair", { body: { action: "claim", code: s.json.code }, bearer: B.jwt });
  check("another user is not affected by that lockout", ok.status === 200);
  const starts: Res[] = [];
  for (let i = 0; i < 25; i++) starts.push(await fn("pair", { body: { action: "start" } }));
  const refused = starts.filter((x) => x.status === 429);
  check("pairing start flood is rate limited", refused.length > 0, `${refused.length} of 25 refused`);
  // The per-ADDRESS limit (10/hour) has its own message; the per-instance limiter (20/min) does not.
  // Seeing the address message proves the edge supplies a client address and the database counted it.
  check("the refusal comes from the per-network-address limit (client address header works on production)", refused.some((x) => /your network/i.test(String(x.json.error?.message))), String(refused[0]?.json.error?.message));
  check("poll with a malformed token is 401", (await fn("pair", { body: { action: "poll" }, device: "x" })).status === 401);

  // ---------------------------------------------------------------- read-rate abuse
  console.log("\n# request flooding");
  const flood = await Promise.all(Array.from({ length: 80 }, () => fn("positions", { bearer: A.jwt })));
  const codesFlood = new Set(flood.map((r) => r.status));
  check("80 parallel snapshot requests never produce a 5xx", ![...codesFlood].some((c) => c >= 500), `statuses ${[...codesFlood].join(",")}`);
  const pf = await Promise.all(Array.from({ length: 40 }, () => fn("prices")));
  check("40 parallel public price requests never produce a 5xx", pf.every((r) => r.status < 500), `statuses ${[...new Set(pf.map((r) => r.status))].join(",")}`);

  // ---------------------------------------------------------------- clean up
  console.log("\n# clean up");
  const v = await fn("paper", { bearer: A.jwt });
  for (const p of v.json.positions ?? []) await fn("paper", { body: { action: "close", symbol: p.symbol, clientId: cid() }, bearer: A.jwt });
  await fn("limits", { body: { killSwitch: false }, bearer: A.jwt });
  console.log("  (test users are anonymous accounts; their fills stay as history by design)");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("FAILED: " + failures.join(" | "));
}

main().then(() => process.exit(fail ? 1 : 0)).catch((e) => {
  console.error("script error:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
