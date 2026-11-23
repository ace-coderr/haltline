// The paper market: which symbols exist, their lot sizes, and the (clearly stated) fee,
// slippage and leverage model. Prices are quoted in USD; the paper account is in USD.

export interface InstrumentSpec {
  /** Display symbol used everywhere in Haltline. */
  symbol: string;
  base: string;
  /** Market symbol on the public price source (lowercase). */
  sourcePair: string;
  qtyStep: number;
  minQty: number;
}

export const INSTRUMENTS: readonly InstrumentSpec[] = [
  { symbol: "BTCUSD", base: "BTC", sourcePair: "btcusd", qtyStep: 0.0001, minQty: 0.0001 },
  { symbol: "ETHUSD", base: "ETH", sourcePair: "ethusd", qtyStep: 0.001, minQty: 0.001 },
  { symbol: "SOLUSD", base: "SOL", sourcePair: "solusd", qtyStep: 0.01, minQty: 0.01 },
  { symbol: "XRPUSD", base: "XRP", sourcePair: "xrpusd", qtyStep: 1, minQty: 1 },
  { symbol: "DOGEUSD", base: "DOGE", sourcePair: "dogeusd", qtyStep: 10, minQty: 10 },
];

export function getSpec(symbol: unknown): InstrumentSpec | undefined {
  return typeof symbol === "string" ? INSTRUMENTS.find((i) => i.symbol === symbol) : undefined;
}

/** The paper trading model. Shown by the API so nobody has to guess how fills are priced. */
export const MODEL = {
  mode: "PAPER",
  quoteCurrency: "USD",
  startingBalance: 10_000,
  /** Taker fee charged on every fill, as a fraction of notional (0.05%). */
  feeRate: 0.0005,
  /** Extra adverse slippage on top of the live spread, in basis points (0.01%). */
  slippageBps: 1,
  /** Largest total notional allowed, as a multiple of equity. No liquidation engine. */
  maxLeverage: 5,
  priceSource: "Bitstamp public ticker (no API key)",
  fills: "Buys fill at the live ask, sells at the live bid, each plus slippage. Positions are marked at the bid/ask mid.",
} as const;

/** True if `size` is a positive multiple of the lot step and at least the minimum. */
export function isValidQty(size: unknown, spec: InstrumentSpec): size is number {
  if (typeof size !== "number" || !Number.isFinite(size) || size < spec.minQty - 1e-12) return false;
  const steps = size / spec.qtyStep;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}
