// Minimal Bybit V5 client. Testnet only: every request goes through guard.ts, so a
// mainnet base URL fails at construction and a non-allowlisted endpoint cannot be called.
// Endpoint, field and signing details follow the official V5 docs (guide, position,
// closed-pnl, wallet-balance, instruments-info, order/create) read on 2026-11-23.

import type { Instrument, Position } from "./actions.ts";
import { assertReduceOnlyOrderBody, buildExchangeRequest } from "./guard.ts";
import type { PlannedOrder } from "./actions.ts";

export type BybitErrorKind =
  | "region_blocked" // HTTP 403: US/China IP or IP rate limit
  | "rate_limited"
  | "auth" // bad key, signature, permissions, IP binding
  | "clock" // timestamp outside recv_window
  | "exchange" // any other non-zero retCode (order rejected, etc.)
  | "network"
  | "bad_response";

export class BybitError extends Error {
  readonly kind: BybitErrorKind;
  readonly retCode: number | null;
  readonly httpStatus: number | null;
  constructor(kind: BybitErrorKind, message: string, retCode: number | null = null, httpStatus: number | null = null) {
    super(message);
    this.name = "BybitError";
    this.kind = kind;
    this.retCode = retCode;
    this.httpStatus = httpStatus;
  }
}

export interface BybitConfig {
  /** Validated by the testnet guard; mainnet throws here. */
  baseUrl: unknown;
  apiKey: string;
  apiSecret: string;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  recvWindowMs?: number;
  timeoutMs?: number;
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

const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function num(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new BybitError("bad_response", `unexpected value for ${field}`);
  return n;
}

const MAX_PAGES = 20;

export function createBybitClient(cfg: BybitConfig) {
  if (!cfg.apiKey || !cfg.apiSecret) throw new BybitError("auth", "exchange API key/secret are not configured");
  // Fail at construction, not at first request, if the base URL is not testnet.
  buildExchangeRequest(cfg.baseUrl, "GET", "/v5/market/time");

  const fetchFn = cfg.fetchFn ?? fetch;
  const nowMs = cfg.nowMs ?? Date.now;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const recvWindow = String(cfg.recvWindowMs ?? 5000);
  const timeoutMs = cfg.timeoutMs ?? 8000;

  async function once(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string>,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const built = buildExchangeRequest(cfg.baseUrl, method, path, query);
    const bodyString = method === "POST" ? JSON.stringify(body ?? {}) : "";
    const timestamp = String(nowMs());
    const payload = method === "GET" ? built.queryString : bodyString;
    const sign = await hmacSha256Hex(cfg.apiSecret, timestamp + cfg.apiKey + recvWindow + payload);

    let res: Response;
    try {
      res = await fetchFn(built.url, {
        method,
        headers: {
          "X-BAPI-API-KEY": cfg.apiKey,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-SIGN": sign,
          "X-BAPI-RECV-WINDOW": recvWindow,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "POST" ? bodyString : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new BybitError("network", `exchange request failed: ${(e as Error).name}`);
    }

    if (res.status === 403) {
      throw new BybitError(
        "region_blocked",
        "exchange returned 403 (blocked region or IP rate limit)",
        null,
        403,
      );
    }
    if (res.status === 429) throw new BybitError("rate_limited", "exchange rate limit (HTTP 429)", null, 429);

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new BybitError("bad_response", `exchange returned a non-JSON response (HTTP ${res.status})`, null, res.status);
    }
    if (typeof json !== "object" || json === null) {
      throw new BybitError("bad_response", "exchange response is not an object", null, res.status);
    }
    const env = json as Record<string, unknown>;
    const retCode = typeof env.retCode === "number" ? env.retCode : NaN;
    if (!Number.isFinite(retCode)) throw new BybitError("bad_response", "exchange response has no retCode", null, res.status);
    if (retCode !== 0) {
      const msg = typeof env.retMsg === "string" ? env.retMsg : "exchange error";
      let kind: BybitErrorKind = "exchange";
      if (retCode === 10006 || retCode === 10018) kind = "rate_limited";
      else if ([10003, 10004, 10005, 10007, 10010].includes(retCode)) kind = "auth";
      else if (retCode === 10002) kind = "clock";
      else if (retCode === 10009) kind = "region_blocked";
      throw new BybitError(kind, msg, retCode, res.status);
    }
    const result = env.result;
    return typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  }

  /** GET with up to two retries on transient failures. Orders are never retried here. */
  async function get(path: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await once("GET", path, query);
      } catch (e) {
        lastError = e;
        const transient = e instanceof BybitError && (e.kind === "network" || e.kind === "rate_limited" ||
          (e.httpStatus !== null && e.httpStatus >= 500));
        if (!transient || attempt === 2) throw e;
        await sleep(250 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async function paged(path: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await get(path, cursor ? { ...query, cursor } : query);
      const list = Array.isArray(result.list) ? (result.list as Record<string, unknown>[]) : [];
      out.push(...list);
      cursor = typeof result.nextPageCursor === "string" ? result.nextPageCursor : "";
      if (!cursor) return out;
    }
    throw new BybitError("bad_response", `too many pages from ${path}`);
  }

  return {
    async serverTimeMs(): Promise<number> {
      const r = await get("/v5/market/time");
      return Math.floor(num(r.timeNano, "timeNano") / 1e6);
    },

    /** Open linear USDT positions (size > 0). */
    async getPositions(): Promise<OpenPosition[]> {
      const list = await paged("/v5/position/list", { category: "linear", settleCoin: "USDT", limit: "200" });
      const out: OpenPosition[] = [];
      for (const p of list) {
        const size = num(p.size, "size");
        if (size <= 0) continue;
        const side = p.side;
        if (side !== "Buy" && side !== "Sell") throw new BybitError("bad_response", "unexpected position side");
        const idx = num(p.positionIdx, "positionIdx");
        if (idx !== 0 && idx !== 1 && idx !== 2) throw new BybitError("bad_response", "unexpected positionIdx");
        if (typeof p.symbol !== "string") throw new BybitError("bad_response", "unexpected symbol");
        out.push({
          symbol: p.symbol,
          side,
          size,
          positionIdx: idx,
          avgPrice: num(p.avgPrice, "avgPrice"),
          markPrice: num(p.markPrice, "markPrice"),
          unrealisedPnl: num(p.unrealisedPnl, "unrealisedPnl"),
        });
      }
      return out;
    },

    /** Sum of closedPnl for trades closed in [startMs, endMs]. The API allows windows up to 7 days. */
    async getClosedPnl(startMs: number, endMs: number): Promise<number> {
      if (!(endMs > startMs) || endMs - startMs > 7 * 24 * 3600 * 1000) {
        throw new RangeError("closed-pnl window must be positive and at most 7 days");
      }
      const list = await paged("/v5/position/closed-pnl", {
        category: "linear",
        startTime: String(startMs),
        endTime: String(endMs),
        limit: "100",
      });
      let cents = 0;
      for (const row of list) cents += Math.round(num(row.closedPnl, "closedPnl") * 1e8);
      return cents / 1e8;
    },

    async getEquity(): Promise<{ totalEquity: number }> {
      const r = await get("/v5/account/wallet-balance", { accountType: "UNIFIED" });
      const list = Array.isArray(r.list) ? (r.list as Record<string, unknown>[]) : [];
      const acct = list[0];
      if (!acct) throw new BybitError("bad_response", "wallet-balance returned no account");
      return { totalEquity: num(acct.totalEquity, "totalEquity") };
    },

    async getInstrument(symbol: string): Promise<Instrument & { status: string; maxMktOrderQty: number }> {
      const r = await get("/v5/market/instruments-info", { category: "linear", symbol });
      const list = Array.isArray(r.list) ? (r.list as Record<string, unknown>[]) : [];
      const item = list[0];
      const lot = item?.lotSizeFilter as Record<string, unknown> | undefined;
      if (!item || !lot || item.symbol !== symbol) throw new BybitError("bad_response", `no instrument info for ${symbol}`);
      return {
        qtyStep: num(lot.qtyStep, "qtyStep"),
        minOrderQty: num(lot.minOrderQty, "minOrderQty"),
        maxMktOrderQty: num(lot.maxMktOrderQty, "maxMktOrderQty"),
        status: typeof item.status === "string" ? item.status : "",
      };
    },

    /**
     * Places ONE reduce-only market order. Not retried on failure: the caller decides, and
     * orderLinkId makes a deliberate retry idempotent on the exchange side.
     */
    async placeReduceOnlyMarket(order: PlannedOrder, orderLinkId: string): Promise<OrderResult> {
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(orderLinkId)) throw new RangeError("invalid orderLinkId");
      const body = {
        category: "linear",
        symbol: order.symbol,
        side: order.side,
        orderType: "Market",
        qty: order.qty,
        reduceOnly: true,
        positionIdx: order.positionIdx,
        timeInForce: "IOC",
        orderLinkId,
      };
      assertReduceOnlyOrderBody(body);
      const r = await once("POST", "/v5/order/create", {}, body);
      if (typeof r.orderId !== "string" || r.orderId === "") throw new BybitError("bad_response", "order response has no orderId");
      return { orderId: r.orderId, orderLinkId: typeof r.orderLinkId === "string" ? r.orderLinkId : orderLinkId };
    },
  };
}

export type BybitClient = ReturnType<typeof createBybitClient>;
