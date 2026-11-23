// Live end-to-end check against the deployed project. Run: node scripts/live-check.ts
// Reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from ../web/.env (or the environment).
// Needs "Allow anonymous sign-ins" enabled. Never prints tokens or keys.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function env(name: string): string {
  if (process.env[name]) return process.env[name]!;
  try {
    const m = readFileSync(new URL("../../web/.env", import.meta.url), "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m) return m[1]!.trim();
  } catch { /* fall through */ }
  throw new Error(`missing ${name}`);
}
const URL_ = env("VITE_SUPABASE_URL");
const KEY = env("VITE_SUPABASE_ANON_KEY");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  (ok ? passed++ : failed++);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  return ok;
};

type J = Record<string, any>;
async function fn(name: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: J }> {
  const res = await fetch(`${URL_}/functions/v1/${name}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { apikey: KEY, "Content-Type": "application/json", "x-region": "eu-central-1", ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: J = {};
  try { json = await res.json() as J; } catch { /* non-json */ }
  return { status: res.status, json };
}

async function main() {
  // 1. health + prices
  const health = await fn("health");
  console.log("health:", JSON.stringify({ ok: health.json.ok, region: health.json.region, db: health.json.db, dbCode: health.json.dbCode, priceSource: health.json.priceSource, voice: health.json.voice, mode: health.json.mode }));
  check("health db ok", health.json.db === "ok");
  check("health price source ok", health.json.priceSource?.status === "ok", String(health.json.priceSource?.status));
  const prices = await fn("prices");
  check("prices: live quotes, labelled PAPER", prices.status === 200 && prices.json.mode === "PAPER" && prices.json.quotes?.length === 5, `HTTP ${prices.status}`);
  if (prices.json.quotes) console.log("  quotes:", prices.json.quotes.map((q: J) => `${q.symbol} ${q.bid}/${q.ask} (${q.ageMs}ms)`).join(", "));
  if (!health.json.priceSource || health.json.priceSource.status !== "ok" || health.json.db !== "ok") return;

  // 2. anonymous session
  const su = await fetch(`${URL_}/auth/v1/signup`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: "{}" });
  const sj = await su.json() as J;
  if (!check("anonymous sign-in", su.status === 200 && !!sj.access_token, `HTTP ${su.status}${sj.error_code ? " " + sj.error_code : ""}`)) return;
  const jwt: string = sj.access_token;
  const userId: string = sj.user.id;
  const asUser = { authorization: `Bearer ${jwt}` };

  // 3. pairing: glasses start -> website claim -> glasses poll
  const start = await fn("pair", { body: { action: "start" } });
  check("pair start returns a 6-digit code and a token", start.status === 200 && /^\d{6}$/.test(start.json.code) && start.json.token?.length >= 32);
  const token: string = start.json.token;
  const dev = { "x-device-token": token };
  const poll1 = await fn("pair", { body: { action: "poll" }, headers: dev });
  check("pair poll is pending before claim", poll1.json.status === "pending", poll1.json.status);
  const wrong = await fn("pair", { body: { action: "claim", code: start.json.code === "000000" ? "000001" : "000000" }, headers: asUser });
  check("wrong code is refused", wrong.status === 400 && wrong.json.error?.code === "invalid_code", `HTTP ${wrong.status}`);
  const claim = await fn("pair", { body: { action: "claim", code: start.json.code }, headers: asUser });
  check("claim with the real code pairs the device", claim.status === 200 && claim.json.paired === true, `HTTP ${claim.status}`);
  const poll2 = await fn("pair", { body: { action: "poll" }, headers: dev });
  check("pair poll reports paired", poll2.json.status === "paired", poll2.json.status);
  const noAuth = await fn("positions");
  check("no credentials is 401", noAuth.status === 401);

  // 4. limit (as the glasses would)
  const lim = await fn("limits", { body: { limit: 500 }, headers: dev });
  check("set limit 500 via device token", lim.status === 200 && lim.json.limit === 500, `HTTP ${lim.status}`);
  const badLim = await fn("limits", { body: { limit: -5 }, headers: dev });
  check("invalid limit refused", badLim.status === 400);
  const ks = await fn("limits", { body: { killSwitch: true }, headers: dev });
  check("device cannot change the kill switch", ks.status === 403);

  // 5. open a paper position at the live price (as the website would)
  const before = await fn("paper", { headers: asUser });
  check("paper account view", before.status === 200 && before.json.mode === "PAPER" && before.json.balance === 10000, `balance ${before.json.balance}`);
  const open = await fn("paper", { body: { action: "open", symbol: "ETHUSD", side: "Buy", size: 2, clientId: randomUUID().slice(0, 24) }, headers: asUser });
  check("open paper long ETHUSD 2", open.status === 200 && open.json.position?.size === 2, `HTTP ${open.status} ${open.json.error?.code ?? ""}`);
  const openAgain = await fn("paper", { body: { action: "open", symbol: "ETHUSD", side: "Buy", size: 0.0001, clientId: "short" }, headers: asUser });
  check("open without a valid clientId is refused", openAgain.status === 400);

  // 6. snapshot
  const snap = await fn("positions", { headers: dev });
  console.log("  snapshot:", JSON.stringify({ state: snap.json.state, left: snap.json.left, used: snap.json.used, limit: snap.json.limit, mode: snap.json.mode, positions: snap.json.positions }));
  check("positions snapshot shows the live paper position", snap.status === 200 && snap.json.positions?.length === 1 && snap.json.positions[0].symbol === "ETHUSD" && snap.json.mode === "PAPER", `HTTP ${snap.status}`);
  check("snapshot state is computed against the limit", ["CALM", "CLOSING", "TRIPPED"].includes(snap.json.state), snap.json.state);

  // 7. propose + confirm cut half
  const prop = await fn("act", { body: { action: "propose", kind: "cut_half" }, headers: dev });
  console.log("  proposal:", JSON.stringify({ status: prop.status, orders: prop.json.orders, expiresInSeconds: prop.json.expiresInSeconds, err: prop.json.error?.code }));
  check("propose cut_half plans a reduce-only order for half", prop.status === 200 && prop.json.orders?.[0]?.side === "Sell" && Number(prop.json.orders[0].qty) === 1, `HTTP ${prop.status}`);
  const tooSoon = await fn("act", { body: { action: "confirm", proposalId: prop.json.proposalId, kind: "cut_half" }, headers: dev });
  check("immediate confirm is refused as a stray press", tooSoon.status === 425, `HTTP ${tooSoon.status} ${tooSoon.json.error?.code ?? ""}`);
  await sleep(1500);
  const conf = await fn("act", { body: { action: "confirm", proposalId: prop.json.proposalId, kind: "cut_half" }, headers: dev });
  console.log("  confirm:", JSON.stringify({ status: conf.status, executed: conf.json.executed, failed: conf.json.failed, results: conf.json.results, err: conf.json.error?.code }));
  check("confirm executes the reduce-only order", conf.status === 200 && conf.json.executed === 1, `HTTP ${conf.status}`);
  const again = await fn("act", { body: { action: "confirm", proposalId: prop.json.proposalId, kind: "cut_half" }, headers: dev });
  check("a second confirm of the same proposal is refused (no double order)", again.status === 409, `HTTP ${again.status} ${again.json.error?.code ?? ""}`);
  const prop2 = await fn("act", { body: { action: "propose", kind: "cut_all" }, headers: dev });
  check("a new action inside the cooldown is refused", prop2.status === 429 && prop2.json.error?.code === "cooldown", `HTTP ${prop2.status}`);
  const snap2 = await fn("positions", { headers: dev });
  check("position is now half the size", Math.abs((snap2.json.positions?.[0]?.size ?? 0) - 1) < 1e-9, String(snap2.json.positions?.[0]?.size));
  const ks2 = await fn("limits", { body: { killSwitch: true }, headers: asUser });
  check("kill switch on (website session)", ks2.status === 200 && ks2.json.killSwitch === true);
  const killed = await fn("act", { body: { action: "propose", kind: "cut_all" }, headers: dev });
  check("kill switch blocks write actions", killed.status === 403 && killed.json.error?.code === "kill_switch", `HTTP ${killed.status}`);
  await fn("limits", { body: { killSwitch: false }, headers: asUser });

  // 8. actions log + fills, read the way the website will (RLS, own rows only)
  const logRes = await fetch(`${URL_}/rest/v1/actions_log?select=kind,status,reason,symbol,side,size,created_at&order=created_at.asc`, { headers: { apikey: KEY, authorization: `Bearer ${jwt}` } });
  const log = await logRes.json() as J[];
  console.log("  actions log:");
  for (const r of log) console.log(`    ${r.created_at}  ${r.kind}  ${r.status}${r.reason ? " (" + r.reason + ")" : ""}  ${r.symbol ?? ""} ${r.side ?? ""} ${r.size ?? ""}`);
  check("actions log is readable by its owner and records the executed cut", logRes.status === 200 && log.some((r) => r.kind === "cut_half" && r.status === "executed" && r.symbol === "ETHUSD"), `HTTP ${logRes.status}`);
  const noRead = await fetch(`${URL_}/rest/v1/actions_log?select=*`, { headers: { apikey: KEY } });
  check("anonymous (no session) cannot read the actions log", noRead.status === 401 || noRead.status === 403 || (await noRead.json() as J[]).length === 0, `HTTP ${noRead.status}`);

  // 9. clean up: close everything, reset the paper account
  const view = await fn("paper", { headers: asUser });
  for (const p of view.json.positions ?? []) {
    const c = await fn("paper", { body: { action: "close", symbol: p.symbol, clientId: randomUUID().slice(0, 24) }, headers: asUser });
    check(`close ${p.symbol}`, c.status === 200, `HTTP ${c.status} ${c.json.error?.code ?? ""}`);
  }
  const flat = await fn("positions", { headers: dev });
  check("account is flat", flat.status === 200 && flat.json.positions?.length === 0);
  const fin = await fn("paper", { headers: asUser });
  console.log("  fills:");
  for (const f of fin.json.fills ?? []) console.log(`    ${f.at}  ${f.source}  ${f.side} ${f.qty} ${f.symbol} @ ${f.price}  fee ${f.fee.toFixed(4)}  realised ${f.realizedPnl.toFixed(4)}`);
  console.log(`  balance after the test: ${fin.json.balance.toFixed(4)} (fees and spread are the cost of the round trip)`);
  const reset = await fn("paper", { body: { action: "reset" }, headers: asUser });
  check("reset paper account to 10,000", reset.status === 200 && reset.json.reset === true);
  console.log(`  (test user ${userId.slice(0, 8)}… is an anonymous account; fill history is kept by design)`);
}

main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error("script error:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
