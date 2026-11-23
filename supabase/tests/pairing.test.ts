import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, USER_A, USER_B } from "./db.ts";

let db: PGlite;
const T1 = "1".repeat(64);
const T2 = "2".repeat(64);

type R = Record<string, unknown>;
const fn = async (sql: string, params: unknown[] = []): Promise<R> =>
  ((await db.query<{ r: R }>(`select ${sql} as r`, params)).rows[0] as { r: R }).r;
const start = (code: string, hash = T1, ttl = 600, max = 200) =>
  fn("start_pairing($1,$2,$3,$4)", [code, hash, ttl, max]);
const claim = (user: string, code: string, uf = 5, gf = 60) =>
  fn("claim_pairing_code($1,$2,$3,$4,600)", [user, code, uf, gf]);
const redeem = (hash: string) => fn("redeem_pairing($1)", [hash]);

before(async () => {
  db = await createDb();
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec("truncate pairing_codes, pairing_attempts, devices cascade");
});

test("happy path: start -> pending -> claim -> paired device, code deleted", async () => {
  assert.deepEqual(await start("123456"), { ok: true, reason: null });
  assert.equal((await redeem(T1)).status, "pending");
  assert.deepEqual(await claim(USER_A, "123456"), { ok: true, reason: null });
  const paired = await redeem(T1);
  assert.equal(paired.status, "paired");
  const dev = (await db.query<{ user_id: string }>("select user_id from devices where token_hash = $1", [T1])).rows;
  assert.equal(dev.length, 1);
  assert.equal(dev[0]!.user_id, USER_A);
  assert.equal((await db.query("select 1 from pairing_codes")).rows.length, 0);
  // redeeming again is idempotent and returns the same device
  const again = await redeem(T1);
  assert.equal(again.status, "paired");
  assert.equal(again.device_id, paired.device_id);
  assert.equal((await db.query("select 1 from devices")).rows.length, 1);
});

test("a claimed code cannot be claimed again by another user", async () => {
  await start("123456");
  assert.equal((await claim(USER_A, "123456")).ok, true);
  assert.deepEqual(await claim(USER_B, "123456"), { ok: false, reason: "invalid_code" });
});

test("wrong or malformed codes are invalid and recorded", async () => {
  await start("123456");
  for (const bad of ["654321", "12345", "1234567", "abcdef", "", "12345 "]) {
    assert.equal((await claim(USER_A, bad, 100, 100)).reason, "invalid_code", bad);
  }
  const n = (await db.query<{ c: number }>("select count(*)::int as c from pairing_attempts where not succeeded")).rows[0]!.c;
  assert.equal(n, 6);
  assert.equal((await redeem(T1)).status, "pending", "real code is untouched");
});

test("per-user brute force: after 5 failures even the correct code is refused", async () => {
  await start("123456");
  for (let i = 0; i < 5; i++) assert.equal((await claim(USER_A, `00000${i}`)).reason, "invalid_code");
  assert.equal((await claim(USER_A, "123456")).reason, "rate_limited");
  // another user is unaffected by A's lockout
  assert.equal((await claim(USER_B, "123456")).ok, true);
});

test("global brute force: many throwaway accounts cannot exceed the global failure budget", async () => {
  await start("123456");
  // 3 failures each from the two users, global budget of 5
  for (let i = 0; i < 3; i++) await claim(USER_A, `00000${i}`, 100, 5);
  for (let i = 0; i < 2; i++) await claim(USER_B, `10000${i}`, 100, 5);
  assert.equal((await claim(USER_B, "123456", 100, 5)).reason, "rate_limited");
});

test("expired codes cannot be claimed and are reported as expired", async () => {
  await start("123456", T1, 600);
  await db.query("update pairing_codes set expires_at = now() - interval '1 second'");
  assert.equal((await redeem(T1)).status, "expired");
  await start("222222", T2, 600);
  await db.query("update pairing_codes set expires_at = now() - interval '1 second'");
  assert.equal((await claim(USER_A, "222222")).reason, "invalid_code");
  assert.equal((await redeem(T2)).status, "unknown", "swept by the claim call");
});

test("unknown tokens are unknown, not paired", async () => {
  assert.equal((await redeem("f".repeat(64))).status, "unknown");
});

test("start_pairing: duplicate code reports collision, pending cap reports busy", async () => {
  assert.equal((await start("123456", T1)).ok, true);
  assert.deepEqual(await start("123456", T2), { ok: false, reason: "collision" });
  assert.deepEqual(await start("654321", T2, 600, 1), { ok: false, reason: "busy" });
});

test("pairing helpers are not callable by API roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query("select claim_pairing_code($1, '123456')", [USER_A]), Error, role);
      await assert.rejects(db.query("select redeem_pairing($1)", [T1]), Error, role);
      await assert.rejects(db.query("select * from pairing_attempts"), Error, role);
    } finally {
      await db.exec("reset role");
    }
  }
});

test("audit: pairing start is limited per client address hash (10 per hour), other addresses unaffected", async () => {
  const ipA = "a".repeat(64);
  const ipB = "b".repeat(64);
  const startIp = (code: string, ip: string | null) => fn("start_pairing($1,$2,$3,$4,$5,10,3600)", [code, String(code).padEnd(64, "0"), 600, 200, ip]);
  for (let i = 0; i < 10; i++) assert.equal((await startIp(String(100000 + i), ipA)).ok, true, `start ${i}`);
  assert.deepEqual(await startIp("200000", ipA), { ok: false, reason: "ip_limited" });
  assert.equal((await startIp("200001", ipB)).ok, true);
  assert.equal((await startIp("200002", null)).ok, true, "no address means no per-address limit");
  // the window slides: old starts stop counting
  await db.query("update pairing_starts set at = now() - interval '2 hours' where ip_hash = $1", [ipA]);
  assert.equal((await startIp("200003", ipA)).ok, true);
});

test("audit: pairing_starts is not readable by API roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query("select * from pairing_starts"), Error, role);
    } finally {
      await db.exec("reset role");
    }
  }
});
