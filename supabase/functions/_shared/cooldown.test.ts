import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCooldown,
  COOLDOWN_MS,
  createProposal,
  MIN_CONFIRM_DELAY_MS,
  PROPOSAL_TTL_MS,
  requiresConfirmation,
  validateConfirm,
} from "./cooldown.ts";

const T = 1_000_000;

test("first action is allowed", () => {
  assert.deepEqual(checkCooldown(null, T), { allowed: true, retryAfterMs: 0 });
});

test("action inside the window is blocked with the remaining time", () => {
  assert.deepEqual(checkCooldown(T, T + 10_000), { allowed: false, retryAfterMs: COOLDOWN_MS - 10_000 });
  assert.deepEqual(checkCooldown(T, T), { allowed: false, retryAfterMs: COOLDOWN_MS });
  assert.equal(checkCooldown(T, T + COOLDOWN_MS - 1).allowed, false);
});

test("action at or after the window is allowed", () => {
  assert.equal(checkCooldown(T, T + COOLDOWN_MS).allowed, true);
  assert.equal(checkCooldown(T, T + COOLDOWN_MS * 5).allowed, true);
});

test("clock going backwards fails closed", () => {
  const r = checkCooldown(T, T - 5_000);
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterMs, COOLDOWN_MS);
});

test("non-finite inputs fail closed", () => {
  assert.equal(checkCooldown(NaN, T).allowed, false);
  assert.equal(checkCooldown(T, NaN).allowed, false);
  assert.equal(checkCooldown(T, T + 1, -1).allowed, false);
});

test("a proposal confirms inside the valid window", () => {
  const p = createProposal("abc", "cut_half", T);
  assert.equal(p.expiresAtMs, T + PROPOSAL_TTL_MS);
  assert.deepEqual(validateConfirm(p, "cut_half", T + MIN_CONFIRM_DELAY_MS), { ok: true });
  assert.deepEqual(validateConfirm(p, "cut_half", T + PROPOSAL_TTL_MS - 1), { ok: true });
});

test("a confirm that arrives too fast is rejected as a stray press", () => {
  const p = createProposal("abc", "cut_all", T);
  assert.deepEqual(validateConfirm(p, "cut_all", T), { ok: false, reason: "too_soon" });
  assert.deepEqual(validateConfirm(p, "cut_all", T + MIN_CONFIRM_DELAY_MS - 1), { ok: false, reason: "too_soon" });
});

test("expired, consumed, mismatched and missing proposals are rejected", () => {
  const p = createProposal("abc", "cut_half", T);
  assert.deepEqual(validateConfirm(p, "cut_half", T + PROPOSAL_TTL_MS), { ok: false, reason: "expired" });
  assert.deepEqual(validateConfirm({ ...p, consumedAtMs: T + 1000 }, "cut_half", T + 2000), {
    ok: false,
    reason: "consumed",
  });
  assert.deepEqual(validateConfirm(p, "cut_all", T + 2000), { ok: false, reason: "kind_mismatch" });
  assert.deepEqual(validateConfirm(null, "cut_half", T), { ok: false, reason: "missing" });
  assert.deepEqual(validateConfirm(undefined, "cut_half", T), { ok: false, reason: "missing" });
});

test("a proposal cannot be confirmed before it was created", () => {
  const p = createProposal("abc", "cut_half", T);
  assert.deepEqual(validateConfirm(p, "cut_half", T - 1), { ok: false, reason: "bad_clock" });
  assert.deepEqual(validateConfirm(p, "cut_half", NaN), { ok: false, reason: "bad_clock" });
});

test("only write actions need confirmation", () => {
  assert.equal(requiresConfirmation("cut_half"), true);
  assert.equal(requiresConfirmation("cut_all"), true);
  assert.equal(requiresConfirmation("dismiss"), false);
});
