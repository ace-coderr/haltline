// HTTP plumbing shared by every Edge Function: CORS, JSON responses, typed errors,
// size-limited body reading, and caller authentication.
//
// CORS: Access-Control-Allow-Origin is "*" on purpose. Authentication is by Bearer token
// or the x-device-token header, never by cookies, so a foreign page cannot ride on a
// user's ambient credentials. The glasses WebView has no fixed, documented origin.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-device-token, x-client-info, x-region",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return jsonResponse({ ok: false, error: { code: e.code, message: e.message, ...e.extra } }, e.status);
  }
  // Never leak internals: log server-side, return a generic message.
  console.error("unhandled error", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  return jsonResponse({ ok: false, error: { code: "internal_error", message: "Something went wrong." } }, 500);
}

/** Wraps a route: handles OPTIONS, enforces allowed methods, converts throws into responses. */
export function route(methods: readonly string[], fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (!methods.includes(req.method)) {
      return errorResponse(new ApiError(405, "method_not_allowed", `Use ${methods.join(" or ")}.`));
    }
    try {
      return await fn(req);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** Reads at most `max` bytes of the body, rejecting with 413 beyond that. */
export async function readBytesLimited(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new ApiError(413, "body_too_large", "Request body is too large.");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function readJsonObject(req: Request, max = 8_000): Promise<Record<string, unknown>> {
  const bytes = await readBytesLimited(req, max);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "bad_json", "Body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "bad_json", "Body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface Caller {
  userId: string;
  /** "device" = glasses (device token), "user" = web session (Supabase JWT). */
  via: "device" | "user";
  deviceId: string | null;
}

export interface AuthDeps {
  findDeviceByHash(hash: string): Promise<{ id: string; user_id: string } | null>;
  touchDevice(id: string): Promise<void>;
  verifyJwt(jwt: string): Promise<{ userId: string } | null>;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export async function authenticate(req: Request, deps: AuthDeps): Promise<Caller> {
  const deviceToken = req.headers.get("x-device-token");
  if (deviceToken !== null) {
    if (!DEVICE_TOKEN_RE.test(deviceToken)) throw new ApiError(401, "unauthorized", "Invalid device token.");
    const device = await deps.findDeviceByHash(await sha256Hex(deviceToken));
    if (!device) throw new ApiError(401, "unauthorized", "This device is not paired or was removed.");
    await deps.touchDevice(device.id).catch(() => {});
    return { userId: device.user_id, via: "device", deviceId: device.id };
  }
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (m) {
    const user = await deps.verifyJwt(m[1]!);
    if (user) return { userId: user.userId, via: "user", deviceId: null };
  }
  throw new ApiError(401, "unauthorized", "Sign in or pair a device first.");
}

/** Tiny fixed-window limiter, per isolate. Protects the shared free-tier quotas. */
export class WindowLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  /** Returns 0 if allowed, otherwise milliseconds until the window resets. */
  check(key: string, nowMs: number): number {
    const h = this.hits.get(key);
    if (!h || nowMs - h.start >= this.windowMs) {
      this.hits.set(key, { start: nowMs, count: 1 });
      if (this.hits.size > 5000) this.hits.clear();
      return 0;
    }
    if (h.count >= this.max) return this.windowMs - (nowMs - h.start);
    h.count += 1;
    return 0;
  }
}
