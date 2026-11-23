// The PAPER exchange adapter: a simulated account in our own Postgres, priced from real
// public market data. It implements ExchangeAdapter, plus the account operations the
// website's paper-trading panel needs (open, close, reset, account view).
//
// It never touches the network itself (prices come in through the injected PriceFeed) and
// never contains a path to any real exchange. All balance and position changes go through
// the atomic paper_apply_fill SQL function.

import type { Instrument, PlannedOrder, Side } from "./actions.ts";
import { type ExchangeAdapter, ExchangeError, type OpenPosition, type OrderResult } from "./exchange.ts";
import { assertReduceOnlyOrder } from "./guard.ts";
import { getSpec, INSTRUMENTS, isValidQty, MODEL } from "./instruments.ts";
import { type PriceFeed, type Quote, quoteAge } from "./prices.ts";

export interface PositionRow {
  symbol: string;
  side: Side;
  size: number;
  entry_price: number;
}

export interface FillRow {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  realized_pnl: number;
  reduce_only: boolean;
  source: "manual" | "guard";
  created_at: string;
}

export interface ApplyFillArgs {
  userId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  feeRate: number;
  reduceOnly: boolean;
  linkId: string | null;
  source: "manual" | "guard";
  maxLeverage: number;
  marks: Record<string, number>;
  startingBalance: number;
}

export interface ApplyFillResult {
  ok: boolean;
  reason: string | null;
  duplicate?: boolean;
  fill_id?: string;
  realized_pnl?: number;
  fee?: number;
  balance?: number;
  position?: { side: Side; size: number; entry_price: number } | null;
}

export interface PaperStore {
  getPositions(userId: string): Promise<PositionRow[]>;
  getAccount(userId: string): Promise<{ balance: number; starting_balance: number } | null>;
  applyFill(args: ApplyFillArgs): Promise<ApplyFillResult>;
  realizedSince(userId: string, sinceIso: string): Promise<number>;
  listFills(userId: string, limit: number): Promise<FillRow[]>;
  reset(userId: string, startingBalance: number): Promise<{ ok: boolean; reason: string | null }>;
}

export interface PaperDeps {
  store: PaperStore;
  prices: PriceFeed;
  now: () => number;
}

/** Fill price for a market order: the live ask for buys, the live bid for sells, plus slippage. */
export function fillPrice(side: Side, q: Pick<Quote, "bid" | "ask">, slippageBps: number = MODEL.slippageBps): number {
  const slip = slippageBps / 10_000;
  const raw = side === "Buy" ? q.ask * (1 + slip) : q.bid * (1 - slip);
  return Math.round(raw * 1e8) / 1e8;
}

/** Mark price used for unrealised PnL and margin: the bid/ask mid. */
export const markPrice = (q: Pick<Quote, "bid" | "ask">): number => (q.bid + q.ask) / 2;

const opposite = (s: Side): Side => (s === "Buy" ? "Sell" : "Buy");

export function unrealisedPnl(side: Side, size: number, entry: number, mark: number): number {
  return side === "Buy" ? (mark - entry) * size : (entry - mark) * size;
}

const reasonText: Record<string, string> = {
  reduce_only_no_position: "There is no position to reduce.",
  reduce_only_wrong_side: "That order would add to the position, not reduce it.",
  reduce_only_exceeds_position: "That is larger than the open position.",
  insufficient_margin: `Not enough margin: total exposure is capped at ${MODEL.maxLeverage}x equity.`,
  no_mark: "A price for another open position is unavailable.",
};

export function createPaperExchange(deps: PaperDeps) {
  const { store, prices } = deps;

  async function applyFill(
    userId: string, symbol: string, side: Side, qty: number, reduceOnly: boolean,
    source: "manual" | "guard", linkId: string | null, extraSymbols: readonly string[],
  ) {
    const symbols = [...new Set([symbol, ...extraSymbols])];
    const quotes = await prices.getQuotes(symbols);
    const quote = quotes.get(symbol)!;
    const marks: Record<string, number> = {};
    for (const [s, q] of quotes) marks[s] = markPrice(q);
    const r = await store.applyFill({
      userId, symbol, side, qty, price: fillPrice(side, quote), feeRate: MODEL.feeRate, reduceOnly,
      linkId, source, maxLeverage: MODEL.maxLeverage, marks, startingBalance: MODEL.startingBalance,
    });
    if (!r.ok) throw new ExchangeError("rejected", reasonText[r.reason ?? ""] ?? "The paper account rejected the order.", r.reason);
    return r;
  }

  const adapter: ExchangeAdapter = {
    mode: "PAPER",

    async health() {
      const quotes = await prices.getQuotes();
      const now = deps.now();
      let oldest = 0;
      for (const q of quotes.values()) oldest = Math.max(oldest, quoteAge(q, now));
      return { priceAgeMs: oldest };
    },

    async getPositions(userId): Promise<OpenPosition[]> {
      const rows = await store.getPositions(userId);
      if (rows.length === 0) return []; // an empty account needs no prices
      const quotes = await prices.getQuotes(rows.map((r) => r.symbol));
      return rows.map((r) => {
        const mark = markPrice(quotes.get(r.symbol)!);
        return {
          symbol: r.symbol, side: r.side, size: Number(r.size), positionIdx: 0 as const,
          avgPrice: Number(r.entry_price), markPrice: mark,
          unrealisedPnl: unrealisedPnl(r.side, Number(r.size), Number(r.entry_price), mark),
        };
      });
    },

    getRealizedSince: (userId, sinceMs) => store.realizedSince(userId, new Date(sinceMs).toISOString()),

    async getInstrument(symbol): Promise<Instrument & { status: string }> {
      const spec = getSpec(symbol);
      if (!spec) throw new ExchangeError("unsupported_symbol", `unsupported symbol ${symbol}`);
      return { qtyStep: spec.qtyStep, minOrderQty: spec.minQty, status: "Trading" };
    },

    async placeReduceOnlyMarket(userId, order: PlannedOrder, orderLinkId): Promise<OrderResult> {
      assertReduceOnlyOrder(order);
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(orderLinkId)) throw new ExchangeError("bad_request", "invalid order id");
      const r = await applyFill(userId, order.symbol, order.side, Number(order.qty), true, "guard", orderLinkId, []);
      return { orderId: r.fill_id ?? orderLinkId, orderLinkId };
    },
  };

  /** Website paper-trading panel operations. */
  const panel = {
    async open(userId: string, symbol: unknown, side: unknown, size: unknown, clientId: string) {
      const spec = getSpec(symbol);
      if (!spec) throw new ExchangeError("unsupported_symbol", "Unsupported symbol.");
      if (side !== "Buy" && side !== "Sell") throw new ExchangeError("bad_request", "Side must be Buy (long) or Sell (short).");
      if (!isValidQty(size, spec)) {
        throw new ExchangeError("bad_request", `Size must be a multiple of ${spec.qtyStep} and at least ${spec.minQty} ${spec.base}.`);
      }
      const held = (await store.getPositions(userId)).map((p) => p.symbol);
      const r = await applyFill(userId, spec.symbol, side, size, false, "manual", clientId, held);
      return { fillId: r.fill_id!, duplicate: r.duplicate === true, balance: r.balance!, position: r.position ?? null };
    },

    async close(userId: string, symbol: unknown, size: unknown, clientId: string) {
      const spec = getSpec(symbol);
      if (!spec) throw new ExchangeError("unsupported_symbol", "Unsupported symbol.");
      const pos = (await store.getPositions(userId)).find((p) => p.symbol === spec.symbol);
      if (!pos) throw new ExchangeError("rejected", reasonText.reduce_only_no_position!, "reduce_only_no_position");
      const qty = size === undefined || size === null ? Number(pos.size) : size;
      if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0 || qty > Number(pos.size) + 1e-9) {
        throw new ExchangeError("bad_request", "Size must be positive and no larger than the open position.");
      }
      const r = await applyFill(userId, spec.symbol, opposite(pos.side), qty, true, "manual", clientId, []);
      return { fillId: r.fill_id!, duplicate: r.duplicate === true, balance: r.balance!, position: r.position ?? null };
    },

    async reset(userId: string) {
      const r = await store.reset(userId, MODEL.startingBalance);
      if (!r.ok) throw new ExchangeError("rejected", "Close all positions before resetting the account.", r.reason);
    },

    /** Everything the panel shows: balance, equity, positions at live marks, recent fills, prices. */
    async accountView(userId: string, dayStartMs: number) {
      const [account, rows, fills, realizedToday] = await Promise.all([
        store.getAccount(userId),
        store.getPositions(userId),
        store.listFills(userId, 20),
        store.realizedSince(userId, new Date(dayStartMs).toISOString()),
      ]);
      const quotes = await prices.getQuotes();
      const now = deps.now();
      const balance = account ? Number(account.balance) : MODEL.startingBalance;
      const positions = rows.map((r) => {
        const q = quotes.get(r.symbol)!;
        const mark = markPrice(q);
        return {
          symbol: r.symbol, side: r.side, size: Number(r.size), entryPrice: Number(r.entry_price), markPrice: mark,
          unrealisedPnl: unrealisedPnl(r.side, Number(r.size), Number(r.entry_price), mark),
        };
      });
      const unrealised = positions.reduce((s, p) => s + p.unrealisedPnl, 0);
      return {
        balance, startingBalance: account ? Number(account.starting_balance) : MODEL.startingBalance,
        unrealisedPnl: unrealised, equity: balance + unrealised, realizedToday, positions,
        fills: fills.map((f) => ({
          id: f.id, symbol: f.symbol, side: f.side, qty: Number(f.qty), price: Number(f.price), fee: Number(f.fee),
          realizedPnl: Number(f.realized_pnl), reduceOnly: f.reduce_only, source: f.source, at: f.created_at,
        })),
        prices: INSTRUMENTS.map((i) => {
          const q = quotes.get(i.symbol)!;
          return { symbol: i.symbol, base: i.base, bid: q.bid, ask: q.ask, last: q.last, ageMs: quoteAge(q, now), qtyStep: i.qtyStep, minQty: i.minQty };
        }),
        model: MODEL,
      };
    },
  };

  return { adapter, panel };
}

export type PaperExchange = ReturnType<typeof createPaperExchange>;
