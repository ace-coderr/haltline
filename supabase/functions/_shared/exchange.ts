// The exchange-adapter interface. Haltline talks to "an exchange" only through this
// interface. The one implementation today is the PAPER adapter (paper.ts): a simulated
// account in our own database, priced from real public market data. A real testnet adapter
// would implement the same interface and report mode "TESTNET"; nothing above this layer
// (limits, risk maths, propose/confirm, cooldown, kill switch) would change.

import type { Instrument, PlannedOrder, Position } from "./actions.ts";

export type ExchangeMode = "PAPER";

export type ExchangeErrorKind =
  | "prices_unavailable" // the market data source cannot be reached and nothing usable is cached
  | "prices_stale" // the freshest price we have is too old to trade or mark against
  | "rejected" // the account refused the order (see reason)
  | "unsupported_symbol"
  | "bad_request";

export class ExchangeError extends Error {
  readonly kind: ExchangeErrorKind;
  /** Machine-readable reason, e.g. "insufficient_margin" or "reduce_only_exceeds_position". */
  readonly reason: string | null;
  constructor(kind: ExchangeErrorKind, message: string, reason: string | null = null) {
    super(message);
    this.name = "ExchangeError";
    this.kind = kind;
    this.reason = reason;
  }
}

export interface OpenPosition extends Position {
  avgPrice: number;
  markPrice: number;
  unrealisedPnl: number;
}

export interface OrderResult {
  orderId: string;
  orderLinkId: string;
}

export interface ExchangeAdapter {
  readonly mode: ExchangeMode;
  /** Resolves with the age of the freshest price; rejects if prices cannot be trusted. */
  health(): Promise<{ priceAgeMs: number }>;
  getPositions(userId: string): Promise<OpenPosition[]>;
  /** Realised PnL since `sinceMs`, net of fees. */
  getRealizedSince(userId: string, sinceMs: number): Promise<number>;
  getInstrument(symbol: string): Promise<Instrument & { status: string }>;
  /** Places ONE reduce-only market order. Idempotent per orderLinkId. */
  placeReduceOnlyMarket(userId: string, order: PlannedOrder, orderLinkId: string): Promise<OrderResult>;
}
