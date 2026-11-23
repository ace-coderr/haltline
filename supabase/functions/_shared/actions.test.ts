import { test } from "node:test";
import assert from "node:assert/strict";
import { type Instrument, isActionKind, planReduction, type Position } from "./actions.ts";

const btc: Instrument = { qtyStep: 0.001, minOrderQty: 0.001 };
const eth: Instrument = { qtyStep: 0.01, minOrderQty: 0.01 };
const instruments = { BTCUSDT: btc, ETHUSDT: eth };

const long: Position = { symbol: "BTCUSDT", side: "Buy", size: 0.5, positionIdx: 0 };
const short: Position = { symbol: "ETHUSDT", side: "Sell", size: 3.07, positionIdx: 0 };

test("dismiss places no orders", () => {
  const plan = planReduction("dismiss", [long, short], instruments);
  assert.deepEqual(plan, { orders: [], skipped: [] });
});

test("cut_all closes a long with a Sell, reduce-only, full size", () => {
  const { orders, skipped } = planReduction("cut_all", [long], instruments);
  assert.deepEqual(orders, [
    { symbol: "BTCUSDT", side: "Sell", qty: "0.500", positionIdx: 0, reduceOnly: true },
  ]);
  assert.deepEqual(skipped, []);
});

test("cut_all closes a short with a Buy", () => {
  const { orders } = planReduction("cut_all", [short], instruments);
  assert.equal(orders[0]?.side, "Buy");
  assert.equal(orders[0]?.qty, "3.07");
});

test("cut_half rounds DOWN to the step", () => {
  const { orders } = planReduction("cut_half", [short], instruments);
  // 3.07 / 2 = 1.535 -> 1.53
  assert.equal(orders[0]?.qty, "1.53");
  const { orders: o2 } = planReduction("cut_half", [long], instruments);
  assert.equal(o2[0]?.qty, "0.250");
});

test("no float drift on awkward sizes", () => {
  const p: Position = { symbol: "BTCUSDT", side: "Buy", size: 0.3, positionIdx: 0 };
  const { orders } = planReduction("cut_all", [p], instruments);
  assert.equal(orders[0]?.qty, "0.300"); // 0.3 / 0.001 is 299.99999999999994 in floats
});

test("cut_half on a position at the minimum is skipped, not rounded up", () => {
  const tiny: Position = { symbol: "BTCUSDT", side: "Buy", size: 0.001, positionIdx: 0 };
  const plan = planReduction("cut_half", [tiny], instruments);
  assert.deepEqual(plan.orders, []);
  assert.deepEqual(plan.skipped, [{ symbol: "BTCUSDT", reason: "below_min_qty" }]);
});

test("hedge-mode positionIdx is preserved", () => {
  const hedge: Position = { symbol: "BTCUSDT", side: "Sell", size: 1, positionIdx: 2 };
  const { orders } = planReduction("cut_all", [hedge], instruments);
  assert.equal(orders[0]?.positionIdx, 2);
});

test("unknown instrument is skipped (fail closed)", () => {
  const sol: Position = { symbol: "SOLUSDT", side: "Buy", size: 10, positionIdx: 0 };
  const plan = planReduction("cut_all", [sol], instruments);
  assert.deepEqual(plan.orders, []);
  assert.equal(plan.skipped[0]?.reason, "unknown_instrument");
});

test("bad instrument data is treated as unknown", () => {
  const plan = planReduction("cut_all", [long], { BTCUSDT: { qtyStep: 0, minOrderQty: 0.001 } });
  assert.equal(plan.skipped[0]?.reason, "unknown_instrument");
  const plan2 = planReduction("cut_all", [long], { BTCUSDT: { qtyStep: NaN, minOrderQty: 1 } });
  assert.equal(plan2.skipped[0]?.reason, "unknown_instrument");
});

test("invalid positions are skipped", () => {
  const bad = [
    { symbol: "BTCUSDT", side: "Buy", size: 0, positionIdx: 0 },
    { symbol: "BTCUSDT", side: "Buy", size: -1, positionIdx: 0 },
    { symbol: "BTCUSDT", side: "Buy", size: NaN, positionIdx: 0 },
    { symbol: "BTCUSDT", side: "Long", size: 1, positionIdx: 0 },
    { symbol: "BTCUSDT", side: "Buy", size: 1, positionIdx: 5 },
  ] as unknown as Position[];
  const plan = planReduction("cut_all", bad, instruments);
  assert.deepEqual(plan.orders, []);
  assert.equal(plan.skipped.length, bad.length);
  assert.ok(plan.skipped.every((s) => s.reason === "invalid_position"));
});

test("invariants hold across many sizes and kinds", () => {
  const sizes = [0.001, 0.002, 0.003, 0.07, 0.3, 1, 1.234, 17.777, 999.999];
  for (const size of sizes) {
    for (const side of ["Buy", "Sell"] as const) {
      for (const kind of ["cut_half", "cut_all"] as const) {
        const p: Position = { symbol: "BTCUSDT", side, size, positionIdx: 0 };
        const { orders } = planReduction(kind, [p], instruments);
        for (const o of orders) {
          assert.equal(o.reduceOnly, true);
          assert.notEqual(o.side, side);
          assert.ok(Number(o.qty) <= size + 1e-12, `${o.qty} must not exceed ${size}`);
          assert.ok(Number(o.qty) >= 0.001 - 1e-12);
          if (kind === "cut_half") assert.ok(Number(o.qty) <= size / 2 + 1e-12);
        }
      }
    }
  }
});

test("multiple positions produce one order each", () => {
  const { orders } = planReduction("cut_all", [long, short], instruments);
  assert.equal(orders.length, 2);
});

test("isActionKind accepts only the three kinds", () => {
  assert.ok(isActionKind("cut_half"));
  assert.ok(isActionKind("cut_all"));
  assert.ok(isActionKind("dismiss"));
  for (const bad of ["CUT_ALL", "", "cut", null, undefined, 1, {}]) assert.ok(!isActionKind(bad));
});
