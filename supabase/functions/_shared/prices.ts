// Live prices from the Bitstamp public ticker (no API key). Quotes are cached in the
// database for a few seconds so bursts of requests stay far inside rate limits, and the
// feed FAILS CLOSED: a quote older than MAX_QUOTE_AGE_MS is never used for fills or marks.

import { ExchangeError } from "./exchange.ts";
import { assertOutboundAllowed, buildTickerUrl } from "./guard.ts";
import { INSTRUMENTS } from "./instruments.ts";

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  /** Timestamp reported by the source (ms). */
  sourceTs: number;
  /** When we fetched it (ms). */
  fetchedAt: number;
}

export interface PriceStore {
  readQuotes(): Promise<Quote[]>;
  writeQuotes(quotes: Quote[]): Promise<void>;
}

/** Refresh a cached quote once it is older than this. */
export const REFRESH_AFTER_MS = 4_000;
/** Never trade or mark against a quote older than this (measured from our fetch time). */
export const MAX_QUOTE_AGE_MS = 15_000;
/** Reject a quote whose own source timestamp lags this far behind our clock (frozen feed). */
export const MAX_SOURCE_LAG_MS = 120_000;

const positive = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Validates one Bitstamp ticker response. Every value arrives as a string. */
export function parseBitstampTicker(symbol: string, body: unknown, nowMs: number): Quote {
  if (typeof body !== "object" || body === null) throw new ExchangeError("prices_unavailable", "price source returned no data");
  const b = body as Record<string, unknown>;
  const bid = positive(b.bid);
  const ask = positive(b.ask);
  const last = positive(b.last);
  const ts = positive(b.timestamp);
  if (bid === null || ask === null || last === null || ts === null) {
    throw new ExchangeError("prices_unavailable", "price source returned an unexpected shape");
  }
  if (ask < bid) throw new ExchangeError("prices_unavailable", "price source returned a crossed book");
  const sourceTs = ts * 1000;
  if (nowMs - sourceTs > MAX_SOURCE_LAG_MS) throw new ExchangeError("prices_stale", "price source timestamp is too old");
  return { symbol, bid, ask, last, sourceTs, fetchedAt: nowMs };
}

export const quoteAge = (q: Quote, nowMs: number): number => Math.max(0, nowMs - q.fetchedAt);
export const isUsable = (q: Quote, nowMs: number): boolean => quoteAge(q, nowMs) <= MAX_QUOTE_AGE_MS;

export interface PriceFeedDeps {
  store: PriceStore;
  fetchFn?: typeof fetch;
  now: () => number;
  timeoutMs?: number;
}

export function createPriceFeed(deps: PriceFeedDeps) {
  const fetchFn = deps.fetchFn ?? fetch;

  async function fetchOne(symbol: string, pair: string): Promise<Quote> {
    const url = buildTickerUrl(pair);
    assertOutboundAllowed("GET", url);
    let res: Response;
    try {
      res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(deps.timeoutMs ?? 4000) });
    } catch {
      throw new ExchangeError("prices_unavailable", "could not reach the price source");
    }
    if (!res.ok) throw new ExchangeError("prices_unavailable", `price source error (HTTP ${res.status})`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ExchangeError("prices_unavailable", "price source returned unreadable data");
    }
    return parseBitstampTicker(symbol, json, deps.now());
  }

  /**
   * Returns usable quotes for the requested symbols (all supported symbols by default).
   * Throws ExchangeError if any requested symbol has no usable quote.
   */
  async function getQuotes(symbols?: readonly string[]): Promise<Map<string, Quote>> {
    const wanted = INSTRUMENTS.filter((i) => !symbols || symbols.includes(i.symbol));
    const now = deps.now();
    const cached = new Map((await deps.store.readQuotes()).map((q) => [q.symbol, q]));
    const out = new Map<string, Quote>();
    const toFetch = wanted.filter((i) => {
      const q = cached.get(i.symbol);
      return !q || quoteAge(q, now) >= REFRESH_AFTER_MS;
    });

    if (toFetch.length > 0) {
      const results = await Promise.allSettled(toFetch.map((i) => fetchOne(i.symbol, i.sourcePair)));
      const fresh: Quote[] = [];
      results.forEach((r) => {
        if (r.status === "fulfilled") {
          fresh.push(r.value);
          cached.set(r.value.symbol, r.value);
        } else {
          lastFailure = r.reason;
        }
      });
      if (fresh.length > 0) await deps.store.writeQuotes(fresh).catch(() => {});
    }

    let missing: ExchangeError | null = null;
    for (const i of wanted) {
      const q = cached.get(i.symbol);
      if (q && isUsable(q, deps.now())) out.set(i.symbol, q);
      else if (!missing) {
        missing = q
          ? new ExchangeError("prices_stale", `the latest ${i.symbol} price is too old to use`)
          : lastFailure instanceof ExchangeError ? lastFailure : new ExchangeError("prices_unavailable", "no price available");
      }
    }
    if (missing) throw missing;
    return out;
  }
  let lastFailure: unknown = null;

  return { getQuotes };
}

export type PriceFeed = ReturnType<typeof createPriceFeed>;
