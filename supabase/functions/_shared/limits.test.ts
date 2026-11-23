import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSING_THRESHOLD,
  computeRisk,
  formatUsdWhole,
  MAX_DAILY_LIMIT,
  utcDayStart,
  validateLimit,
} from "./limits.ts";

test("CALM when little of the limit is used", () => {
  const r = computeRisk({ limit: 500, realizedPnl: -50, unrealizedPnl: -38 });
  assert.equal(r.state, "CALM");
  assert.equal(r.used, 88);
  assert.equal(r.left, 412);
  assert.ok(Math.abs(r.fraction - 0.176) < 1e-9);
});

test("CLOSING at exactly 80% used", () => {
  const r = computeRisk({ limit: 500, realizedPnl: -400, unrealizedPnl: 0 });
  assert.equal(r.state, "CLOSING");
  assert.equal(r.left, 100);
  assert.equal(CLOSING_THRESHOLD, 0.8);
});

test("CALM just below 80%", () => {
  const r = computeRisk({ limit: 500, realizedPnl: -399.99, unrealizedPnl: 0 });
  assert.equal(r.state, "CALM");
});

test("example from the product brief: $96 left is CLOSING", () => {
  const r = computeRisk({ limit: 500, realizedPnl: -300, unrealizedPnl: -104 });
  assert.equal(r.state, "CLOSING");
  assert.equal(r.left, 96);
});

test("TRIPPED at exactly the limit and beyond, left never negative", () => {
  const at = computeRisk({ limit: 500, realizedPnl: -500, unrealizedPnl: 0 });
  assert.equal(at.state, "TRIPPED");
  assert.equal(at.left, 0);
  const past = computeRisk({ limit: 500, realizedPnl: -400, unrealizedPnl: -250 });
  assert.equal(past.state, "TRIPPED");
  assert.equal(past.left, 0);
  assert.equal(past.used, 650);
  assert.equal(past.fraction, 1);
});

test("unrealised profit offsets realised loss", () => {
  const r = computeRisk({ limit: 500, realizedPnl: -450, unrealizedPnl: 400 });
  assert.equal(r.state, "CALM");
  assert.equal(r.used, 50);
});

test("net profit means nothing used and full headroom", () => {
  const r = computeRisk({ limit: 500, realizedPnl: 120, unrealizedPnl: 30 });
  assert.equal(r.used, 0);
  assert.equal(r.left, 500);
  assert.equal(r.fraction, 0);
  assert.equal(r.state, "CALM");
});

test("cent-level float noise does not flip a threshold", () => {
  // 0.1 + 0.2 style drift: 0.7 + 0.1 in floats is 0.7999999999999999
  const r = computeRisk({ limit: 1, realizedPnl: -0.7, unrealizedPnl: -0.1 });
  assert.equal(r.state, "CLOSING");
  const t = computeRisk({ limit: 1, realizedPnl: -0.9, unrealizedPnl: -0.1 });
  assert.equal(t.state, "TRIPPED");
});

test("fails closed on non-finite PnL", () => {
  assert.throws(() => computeRisk({ limit: 500, realizedPnl: NaN, unrealizedPnl: 0 }), RangeError);
  assert.throws(() => computeRisk({ limit: 500, realizedPnl: 0, unrealizedPnl: Infinity }), RangeError);
});

test("validateLimit accepts sane values and rounds to cents", () => {
  assert.equal(validateLimit(500), 500);
  assert.equal(validateLimit(12.345), 12.35);
  assert.equal(validateLimit(MAX_DAILY_LIMIT), MAX_DAILY_LIMIT);
});

test("validateLimit rejects bad input", () => {
  for (const bad of [0, -5, 0.5, NaN, Infinity, -Infinity, MAX_DAILY_LIMIT + 1, "500", null, undefined, {}, [], true]) {
    assert.throws(() => validateLimit(bad), RangeError, `should reject ${String(bad)}`);
  }
});

test("computeRisk rejects an invalid limit", () => {
  assert.throws(() => computeRisk({ limit: 0, realizedPnl: 0, unrealizedPnl: 0 }), RangeError);
});

test("utcDayStart returns midnight UTC", () => {
  const t = Date.UTC(2026, 10, 23, 23, 59, 59, 999);
  assert.equal(utcDayStart(t), Date.UTC(2026, 10, 23));
  assert.equal(utcDayStart(Date.UTC(2026, 10, 24)), Date.UTC(2026, 10, 24));
  assert.throws(() => utcDayStart(NaN), RangeError);
});

test("formatUsdWhole rounds down and adds separators", () => {
  assert.equal(formatUsdWhole(412), "$412");
  assert.equal(formatUsdWhole(95.99), "$95");
  assert.equal(formatUsdWhole(1234567.8), "$1,234,567");
  assert.equal(formatUsdWhole(0), "$0");
  assert.equal(formatUsdWhole(-3), "$0");
  assert.equal(formatUsdWhole(NaN), "$--");
});
