// Testnet-only guard. Every exchange request is built through these functions, so the
// backend cannot be pointed at mainnet by configuration, by a bad secret, or by a bug
// elsewhere. Strict allowlists, not blocklists: anything not named here is refused.

export class TestnetGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TestnetGuardError";
    this.code = code;
  }
}

/** The only exchange host this backend will ever talk to. Bybit testnet. */
export const TESTNET_HOST = "api-testnet.bybit.com";
export const TESTNET_ORIGIN = `https://${TESTNET_HOST}`;

/**
 * Validates the configured exchange base URL and returns the normalised origin.
 * Refuses mainnet (api.bybit.com, bytick), Demo Trading (api-demo.bybit.com, which runs on
 * production infrastructure), look-alike hosts, other schemes, credentials in the URL,
 * custom ports, and any path, query or fragment.
 */
export function assertTestnetBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim()) {
    throw new TestnetGuardError("bad_url", "exchange base URL is missing or malformed");
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TestnetGuardError("bad_url", "exchange base URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new TestnetGuardError("not_https", "exchange base URL must be https");
  if (u.username !== "" || u.password !== "") {
    throw new TestnetGuardError("credentials_in_url", "exchange base URL must not contain credentials");
  }
  if (u.hostname !== TESTNET_HOST) {
    throw new TestnetGuardError("not_testnet", `refusing non-testnet host: ${u.hostname}`);
  }
  if (u.port !== "") throw new TestnetGuardError("bad_port", "exchange base URL must not set a port");
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "") {
    throw new TestnetGuardError("bad_path", "exchange base URL must be a bare origin");
  }
  return TESTNET_ORIGIN;
}

/** Endpoints the backend may call. Withdrawals, transfers and key management are absent. */
const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set([
  "GET /v5/market/time",
  "GET /v5/market/instruments-info",
  "GET /v5/position/list",
  "GET /v5/position/closed-pnl",
  "GET /v5/account/wallet-balance",
  "POST /v5/order/create",
]);

export function assertAllowedEndpoint(method: string, path: string): void {
  if (!ALLOWED_ENDPOINTS.has(`${method} ${path}`)) {
    throw new TestnetGuardError("endpoint_not_allowed", `endpoint not allowed: ${method} ${path}`);
  }
}

export interface BuiltRequest {
  url: string;
  /** The exact query string that is sent; sign this string verbatim. Empty for none. */
  queryString: string;
}

/** Builds a request URL after checking the base URL and the endpoint. */
export function buildExchangeRequest(
  baseUrl: unknown,
  method: "GET" | "POST",
  path: string,
  query: Readonly<Record<string, string>> = {},
): BuiltRequest {
  const origin = assertTestnetBaseUrl(baseUrl);
  assertAllowedEndpoint(method, path);
  const queryString = new URLSearchParams(query).toString();
  return { url: queryString ? `${origin}${path}?${queryString}` : `${origin}${path}`, queryString };
}

/**
 * Last check before an order leaves the backend: the body must be a linear-perp,
 * reduce-only order with a positive decimal-string quantity.
 */
export function assertReduceOnlyOrderBody(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TestnetGuardError("bad_order", "order body must be an object");
  }
  const b = body as Record<string, unknown>;
  if (b.reduceOnly !== true) throw new TestnetGuardError("not_reduce_only", "order must be reduce-only");
  if (b.category !== "linear") throw new TestnetGuardError("bad_order", "only linear category is allowed");
  if (b.orderType !== "Market" && b.orderType !== "Limit") {
    throw new TestnetGuardError("bad_order", "orderType must be Market or Limit");
  }
  if (b.side !== "Buy" && b.side !== "Sell") throw new TestnetGuardError("bad_order", "side must be Buy or Sell");
  if (typeof b.symbol !== "string" || !/^[A-Z0-9]{3,20}$/.test(b.symbol)) {
    throw new TestnetGuardError("bad_order", "symbol is invalid");
  }
  if (typeof b.qty !== "string" || !/^\d+(\.\d+)?$/.test(b.qty) || Number(b.qty) <= 0) {
    throw new TestnetGuardError("bad_order", "qty must be a positive decimal string");
  }
}
