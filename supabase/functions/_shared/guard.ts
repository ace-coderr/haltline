// Paper-only guard. The backend contains NO code path that can contact an order,
// trading or payout endpoint of any real exchange. Two layers enforce that:
//
//   1. Every outbound HTTP request must pass assertOutboundAllowed(): an exact allowlist of
//      host + method + path. Today that is exactly two things: the public Bitstamp ticker
//      (GET, no credentials) and the Groq transcription endpoint (POST).
//   2. guard.test.ts scans the source tree and fails if any non-test file mentions a real
//      exchange's trading or payout surface, contains an unlisted URL host, or makes
//      network calls outside the two approved modules (prices.ts, groq.ts).
//
// Order logic lives only in paper.ts and the paper_apply_fill SQL function, which move
// numbers in our own database and never touch the network.

import type { PlannedOrder } from "./actions.ts";
import { getSpec } from "./instruments.ts";

export class PaperGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PaperGuardError";
    this.code = code;
  }
}

interface OutboundRule {
  host: string;
  methods: readonly string[];
  path: RegExp;
}

const TICKER_PAIRS = ["btcusd", "ethusd", "solusd", "xrpusd", "dogeusd"];

export const OUTBOUND_ALLOWLIST: readonly OutboundRule[] = [
  { host: "www.bitstamp.net", methods: ["GET"], path: new RegExp(`^/api/v2/ticker/(${TICKER_PAIRS.join("|")})/$`) },
  { host: "api.groq.com", methods: ["POST"], path: /^\/openai\/v1\/audio\/transcriptions$/ },
];

/** Throws unless the request matches an allowlist rule exactly. Returns the parsed URL. */
export function assertOutboundAllowed(method: string, rawUrl: unknown): URL {
  if (typeof rawUrl !== "string" || rawUrl === "" || rawUrl !== rawUrl.trim()) {
    throw new PaperGuardError("bad_url", "outbound URL is missing or malformed");
  }
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new PaperGuardError("bad_url", "outbound URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new PaperGuardError("not_https", "outbound requests must use https");
  if (u.username !== "" || u.password !== "") throw new PaperGuardError("credentials_in_url", "no credentials in URLs");
  if (u.port !== "") throw new PaperGuardError("bad_port", "no custom ports");
  if (u.search !== "" || u.hash !== "") throw new PaperGuardError("bad_url", "no query or fragment");
  const rule = OUTBOUND_ALLOWLIST.find((r) => r.host === u.hostname);
  if (!rule) throw new PaperGuardError("host_not_allowed", `outbound host not allowed: ${u.hostname}`);
  if (!rule.methods.includes(method)) throw new PaperGuardError("method_not_allowed", `${method} is not allowed for ${u.hostname}`);
  if (!rule.path.test(u.pathname)) throw new PaperGuardError("path_not_allowed", `path not allowed for ${u.hostname}: ${u.pathname}`);
  return u;
}

/** URL of the public ticker for one market pair; validated through the allowlist. */
export function buildTickerUrl(pair: string): string {
  const url = `https://www.bitstamp.net/api/v2/ticker/${pair}/`;
  assertOutboundAllowed("GET", url);
  return url;
}

/**
 * Last check before a simulated order is applied: reduce-only, a supported symbol, a valid
 * side, and a positive decimal-string quantity.
 */
export function assertReduceOnlyOrder(order: unknown): asserts order is PlannedOrder {
  if (typeof order !== "object" || order === null || Array.isArray(order)) {
    throw new PaperGuardError("bad_order", "order must be an object");
  }
  const o = order as Record<string, unknown>;
  if (o.reduceOnly !== true) throw new PaperGuardError("not_reduce_only", "order must be reduce-only");
  if (o.side !== "Buy" && o.side !== "Sell") throw new PaperGuardError("bad_order", "side must be Buy or Sell");
  if (!getSpec(o.symbol)) throw new PaperGuardError("bad_order", "unsupported symbol");
  if (typeof o.qty !== "string" || !/^\d+(\.\d+)?$/.test(o.qty) || Number(o.qty) <= 0) {
    throw new PaperGuardError("bad_order", "qty must be a positive decimal string");
  }
}
