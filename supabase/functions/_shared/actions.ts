// Turns a requested gesture action (cut half / cut all / dismiss) into REDUCE-ONLY
// order instructions. Pure: it never talks to the exchange.
//
// Invariants, each covered by a test:
//   - every planned order has reduceOnly === true
//   - the order side is opposite to the position side
//   - the order quantity never exceeds the position size
//   - anything unclear (unknown instrument, bad size) is skipped, never guessed

export type ActionKind = "cut_half" | "cut_all" | "dismiss";
export const ACTION_KINDS: readonly ActionKind[] = ["cut_half", "cut_all", "dismiss"];

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === "string" && (ACTION_KINDS as readonly string[]).includes(value);
}

export type Side = "Buy" | "Sell";

export interface Position {
  symbol: string;
  /** "Buy" = long, "Sell" = short (Bybit naming). */
  side: Side;
  /** Always positive. */
  size: number;
  /** 0 one-way, 1 hedge long, 2 hedge short. */
  positionIdx: 0 | 1 | 2;
}

export interface Instrument {
  qtyStep: number;
  minOrderQty: number;
}

export interface PlannedOrder {
  symbol: string;
  side: Side;
  /** Decimal string, as the exchange expects. */
  qty: string;
  positionIdx: 0 | 1 | 2;
  reduceOnly: true;
}

export interface SkippedPosition {
  symbol: string;
  reason: "unknown_instrument" | "invalid_position" | "below_min_qty";
}

export interface ReductionPlan {
  orders: PlannedOrder[];
  skipped: SkippedPosition[];
}

function decimalsOf(step: number): number {
  const s = String(step);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

const oppositeSide = (side: Side): Side => (side === "Buy" ? "Sell" : "Buy");

export function planReduction(
  kind: ActionKind,
  positions: readonly Position[],
  instruments: Readonly<Record<string, Instrument | undefined>>,
): ReductionPlan {
  const plan: ReductionPlan = { orders: [], skipped: [] };
  if (kind === "dismiss") return plan;

  for (const p of positions) {
    const inst = instruments[p.symbol];
    const validPosition =
      typeof p.symbol === "string" && p.symbol.length > 0 &&
      (p.side === "Buy" || p.side === "Sell") &&
      Number.isFinite(p.size) && p.size > 0 &&
      (p.positionIdx === 0 || p.positionIdx === 1 || p.positionIdx === 2);
    if (!validPosition) {
      plan.skipped.push({ symbol: String(p.symbol), reason: "invalid_position" });
      continue;
    }
    if (
      !inst || !Number.isFinite(inst.qtyStep) || inst.qtyStep <= 0 ||
      !Number.isFinite(inst.minOrderQty) || inst.minOrderQty <= 0
    ) {
      plan.skipped.push({ symbol: p.symbol, reason: "unknown_instrument" });
      continue;
    }

    // Integer arithmetic in units of 10^-decimals to avoid float drift.
    const decimals = Math.min(12, decimalsOf(inst.qtyStep));
    const scale = 10 ** decimals;
    const stepUnits = Math.round(inst.qtyStep * scale);
    const minUnits = Math.round(inst.minOrderQty * scale);
    const sizeUnits = Math.round(p.size * scale);

    let targetUnits: number;
    if (kind === "cut_all") {
      // Close everything: the full size, floored to the step so we never exceed it.
      targetUnits = Math.floor(sizeUnits / stepUnits) * stepUnits;
    } else {
      targetUnits = Math.floor(Math.floor(sizeUnits / 2) / stepUnits) * stepUnits;
    }

    if (targetUnits < minUnits || targetUnits <= 0) {
      plan.skipped.push({ symbol: p.symbol, reason: "below_min_qty" });
      continue;
    }
    if (targetUnits > sizeUnits) {
      // Cannot happen by construction; guard anyway, fail closed.
      plan.skipped.push({ symbol: p.symbol, reason: "invalid_position" });
      continue;
    }

    plan.orders.push({
      symbol: p.symbol,
      side: oppositeSide(p.side),
      qty: (targetUnits / scale).toFixed(decimals),
      positionIdx: p.positionIdx,
      reduceOnly: true,
    });
  }
  return plan;
}
