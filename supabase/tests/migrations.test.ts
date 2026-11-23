// Applies the real migration to an in-memory Postgres (pglite) with minimal stand-ins for
// Supabase's auth schema and roles, then exercises the atomic helpers and the RLS rules.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createDb } from "./db.ts";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const HASH = "a".repeat(64);

let db: PGlite;

const asRole = async (role: string, sub: string | null, fn: () => Promise<void>) => {
  await db.exec(`select set_config('request.jwt.claim.sub', '${sub ?? ""}', false); set role ${role};`);
  try {
    await fn();
  } finally {
    await db.exec("reset role;");
  }
};
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows;

before(async () => {
  db = await createDb();
});
after(async () => {
  await db.close();
});

test("migration applies and creates all tables", async () => {
  const t = await rows<{ tablename: string }>(
    "select tablename from pg_tables where schemaname='public' order by 1",
  );
  assert.deepEqual(
    t.map((r) => r.tablename),
    ["actions_log", "devices", "limits", "pairing_attempts", "pairing_codes", "paper_accounts", "paper_fills", "paper_positions", "paper_prices", "proposals", "sessions"],
  );
});

test("limit constraints reject out-of-range values", async () => {
  await assert.rejects(db.query("insert into limits (user_id, daily_limit) values ($1, 0)", [A]));
  await assert.rejects(db.query("insert into limits (user_id, daily_limit) values ($1, 1000001)", [A]));
  await db.query("insert into limits (user_id, daily_limit) values ($1, 500) on conflict (user_id) do update set daily_limit = 500", [A]);
});

test("claim_action_slot: first claim wins, second is blocked by cooldown", async () => {
  const first = (await rows<{ r: Record<string, unknown> }>("select claim_action_slot($1, 60) as r", [A]))[0]!.r;
  assert.equal(first.ok, true);
  const second = (await rows<{ r: Record<string, unknown> }>("select claim_action_slot($1, 60) as r", [A]))[0]!.r;
  assert.equal(second.ok, false);
  assert.equal(second.reason, "cooldown");
  assert.ok(Number(second.retry_after_seconds) > 0 && Number(second.retry_after_seconds) <= 60);
});

test("release_action_slot restores the previous time only for the latest claim", async () => {
  await db.query("update limits set last_action_at = null where user_id = $1", [B]);
  const c = (await rows<{ r: { ok: boolean; claimed_at: string; previous: string | null } }>(
    "select claim_action_slot($1, 60) as r", [B]))[0]!.r;
  assert.equal(c.ok, true);
  const released = (await rows<{ ok: boolean }>(
    "select release_action_slot($1, $2::timestamptz, null) as ok", [B, c.claimed_at]))[0]!.ok;
  assert.equal(released, true);
  const again = (await rows<{ r: { ok: boolean } }>("select claim_action_slot($1, 60) as r", [B]))[0]!.r;
  assert.equal(again.ok, true, "slot should be claimable again after release");
  // a stale release (wrong claimed_at) must not reopen the slot
  const stale = (await rows<{ ok: boolean }>(
    "select release_action_slot($1, now() - interval '1 hour', null) as ok", [B]))[0]!.ok;
  assert.equal(stale, false);
  const blocked = (await rows<{ r: { ok: boolean } }>("select claim_action_slot($1, 60) as r", [B]))[0]!.r;
  assert.equal(blocked.ok, false);
});

test("kill switch blocks claims regardless of cooldown", async () => {
  await db.query("update limits set kill_switch = true, last_action_at = null where user_id = $1", [A]);
  const r = (await rows<{ r: { ok: boolean; reason: string } }>("select claim_action_slot($1, 0) as r", [A]))[0]!.r;
  assert.equal(r.ok, false);
  assert.equal(r.reason, "kill_switch");
  await db.query("update limits set kill_switch = false where user_id = $1", [A]);
});

test("cooldown of zero seconds allows back-to-back claims; negative is an error", async () => {
  await db.query("update limits set last_action_at = null where user_id = $1", [A]);
  assert.equal((await rows<{ r: { ok: boolean } }>("select claim_action_slot($1, 0) as r", [A]))[0]!.r.ok, true);
  assert.equal((await rows<{ r: { ok: boolean } }>("select claim_action_slot($1, 0) as r", [A]))[0]!.r.ok, true);
  await assert.rejects(db.query("select claim_action_slot($1, -1)", [A]));
});

const newProposal = async (user: string, kind: string, ageMs: number, ttlMs = 20_000) =>
  (await rows<{ id: string }>(
    `insert into proposals (user_id, kind, orders, created_at, expires_at)
     values ($1, $2, '[{"symbol":"BTCUSDT"}]'::jsonb,
             clock_timestamp() - ($3 || ' milliseconds')::interval,
             clock_timestamp() - ($3 || ' milliseconds')::interval + ($4 || ' milliseconds')::interval)
     returning id`, [user, kind, ageMs, ttlMs]))[0]!.id;

type ConsumeResult = { ok: boolean; reason: string | null; orders?: unknown };
const consume = async (id: string, user: string, kind: string) =>
  (await rows<{ r: ConsumeResult }>("select consume_proposal($1, $2, $3, 800) as r", [id, user, kind]))[0]!.r;

test("consume_proposal: succeeds exactly once", async () => {
  const id = await newProposal(A, "cut_half", 2000);
  const first = await consume(id, A, "cut_half");
  assert.equal(first.ok, true);
  assert.deepEqual(first.orders, [{ symbol: "BTCUSDT" }]);
  assert.equal((await consume(id, A, "cut_half")).reason, "consumed");
});

test("consume_proposal: too soon is rejected and does NOT burn the proposal", async () => {
  const id = await newProposal(A, "cut_all", 0);
  assert.equal((await consume(id, A, "cut_all")).reason, "too_soon");
  await db.query("update proposals set created_at = created_at - interval '2 seconds' where id = $1", [id]);
  assert.equal((await consume(id, A, "cut_all")).ok, true);
});

test("consume_proposal: expired, wrong kind, wrong user, unknown id", async () => {
  const expired = await newProposal(A, "cut_half", 30_000, 20_000);
  assert.equal((await consume(expired, A, "cut_half")).reason, "expired");
  const live = await newProposal(A, "cut_half", 2000);
  assert.equal((await consume(live, A, "cut_all")).reason, "kind_mismatch");
  assert.equal((await consume(live, B, "cut_half")).reason, "missing");
  assert.equal((await consume("00000000-0000-0000-0000-000000000000", A, "cut_half")).reason, "missing");
});

test("RLS: a user reads only their own actions and limits", async () => {
  await db.query(
    "insert into actions_log (user_id, kind, status, symbol, side, size) values ($1,'cut_half','executed','BTCUSDT','Sell',0.25), ($2,'cut_all','failed','ETHUSDT','Buy',1)",
    [A, B],
  );
  await asRole("authenticated", A, async () => {
    const own = await rows<{ user_id: string }>("select user_id from actions_log");
    assert.ok(own.length >= 1 && own.every((r) => r.user_id === A));
    const lim = await rows<{ user_id: string }>("select user_id from limits");
    assert.ok(lim.every((r) => r.user_id === A));
  });
});

test("RLS: clients cannot write limits, actions or proposals, and cannot read secrets", async () => {
  await asRole("authenticated", A, async () => {
    await assert.rejects(db.query("update limits set kill_switch = false, daily_limit = 999999 where user_id = $1", [A]));
    await assert.rejects(db.query("insert into actions_log (user_id, kind, status) values ($1,'dismiss','executed')", [A]));
    await assert.rejects(db.query("select * from proposals"));
    await assert.rejects(db.query("select * from pairing_codes"));
    await assert.rejects(db.query("select token_hash from devices"));
    await assert.rejects(db.query("select claim_action_slot($1, 0)", [A]));
    await assert.rejects(db.query("select consume_proposal($1, $2, 'cut_half', 0)", [A, A]));
  });
});

test("RLS: devices are readable without token_hash and only for the owner", async () => {
  await db.query("insert into devices (user_id, token_hash) values ($1, $2) on conflict do nothing", [A, HASH]);
  await db.query("insert into devices (user_id, token_hash) values ($1, $2) on conflict do nothing", [B, "b".repeat(64)]);
  await asRole("authenticated", A, async () => {
    const d = await rows<{ user_id: string }>("select id, user_id, label from devices");
    assert.ok(d.length >= 1 && d.every((r) => r.user_id === A));
  });
});

test("RLS: anonymous API role gets nothing", async () => {
  await asRole("anon", null, async () => {
    for (const t of ["limits", "devices", "sessions", "actions_log", "proposals", "pairing_codes"]) {
      await assert.rejects(db.query(`select * from ${t}`), Error, `anon must not read ${t}`);
    }
  });
});

test("token hash and pairing code formats are enforced", async () => {
  await assert.rejects(db.query("insert into devices (user_id, token_hash) values ($1, 'plain-token')", [A]));
  await assert.rejects(db.query("insert into pairing_codes (code, token_hash, expires_at) values ('12345', $1, now())", [HASH]));
  await assert.rejects(db.query("insert into pairing_codes (code, token_hash, expires_at) values ('12345a', $1, now())", [HASH]));
  await db.query("insert into pairing_codes (code, token_hash, expires_at) values ('123456', $1, now() + interval '10 minutes')", [HASH]);
});
