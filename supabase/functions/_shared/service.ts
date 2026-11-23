// Business logic behind the Edge Functions. Everything external (database, exchange,
// clock) is injected, so the whole flow is testable without a network.

import { ApiError } from "./api.ts";
import type { Caller } from "./api.ts";
import { type ActionKind, type Instrument, isActionKind, planReduction, type PlannedOrder, type Position } from "./actions.ts";
import { type ExchangeAdapter, ExchangeError, type OpenPosition } from "./exchange.ts";
import { checkCooldown, COOLDOWN_MS, MIN_CONFIRM_DELAY_MS, PROPOSAL_TTL_MS } from "./cooldown.ts";
import { computeRisk, type RiskState, utcDayStart, validateLimit } from "./limits.ts";

export interface LimitsRow {
  daily_limit: number | null;
  kill_switch: boolean;
  last_action_at: string | null;
}

export interface ActionLogRow {
  user_id: string;
  device_id: string | null;
  proposal_id?: string | null;
  kind: ActionKind | "set_limit" | "kill_switch";
  status: "executed" | "failed" | "rejected";
  reason?: string | null;
  symbol?: string | null;
  side?: "Buy" | "Sell" | null;
  size?: number | null;
  detail?: Record<string, unknown>;
}

export interface ClaimResult {
  ok: boolean;
  reason: "kill_switch" | "cooldown" | null;
  retry_after_seconds: number;
  previous: string | null;
  claimed_at?: string;
}

export interface Store {
  ping(): Promise<void>;
  getLimits(userId: string): Promise<LimitsRow>;
  setLimit(userId: string, amount: number): Promise<void>;
  setKillSwitch(userId: string, on: boolean): Promise<void>;
  claimSlot(userId: string, cooldownSeconds: number): Promise<ClaimResult>;
  releaseSlot(userId: string, claimedAt: string, previous: string | null): Promise<void>;
  insertProposal(row: { user_id: string; device_id: string | null; kind: "cut_half" | "cut_all"; orders: PlannedOrder[]; expires_at: string }): Promise<string>;
  consumeProposal(id: string, userId: string, kind: string, minDelayMs: number): Promise<{ ok: boolean; reason: string | null; orders?: PlannedOrder[] }>;
  logAction(row: ActionLogRow): Promise<void>;
  upsertSession(userId: string, day: string, limitAtStart: number, tripped: boolean): Promise<void>;
  startPairing(code: string, tokenHash: string, ttlSeconds: number, maxPending: number, ipHash: string | null): Promise<{ ok: boolean; reason: "collision" | "busy" | "ip_limited" | null }>;
  claimPairing(userId: string, code: string): Promise<{ ok: boolean; reason: "invalid_code" | "rate_limited" | null }>;
  revokeDevice(userId: string, deviceId: string): Promise<boolean>;
  redeemPairing(tokenHash: string): Promise<{ status: "unknown" | "expired" | "pending" | "paired"; expires_at?: string; device_id?: string }>;
}

export interface Ctx {
  store: Store;
  exchange: () => ExchangeAdapter;
  now: () => number;
}

/** Maps exchange/price failures to API errors the clients can show honestly. */
export function exchangeFailure(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ExchangeError) {
    switch (e.kind) {
      case "prices_stale":
        return new ApiError(503, "prices_stale", "Live prices are too old to use right now. Nothing was changed.");
      case "prices_unavailable":
        return new ApiError(503, "prices_unavailable", "The live price source is unavailable. Nothing was changed.");
      case "rejected":
        return new ApiError(409, e.reason ?? "rejected", e.message);
      case "unsupported_symbol":
      case "bad_request":
        return new ApiError(400, e.kind, e.message);
    }
  }
  return new ApiError(503, "exchange_unavailable", "The paper exchange is unavailable.");
}

// ---------------------------------------------------------------------------
// Snapshot (read)
// ---------------------------------------------------------------------------

export type SnapshotState = RiskState | "NO_LIMIT";

export interface Snapshot {
  asOf: string;
  state: SnapshotState;
  limit: number | null;
  used: number | null;
  left: number | null;
  fraction: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  killSwitch: boolean;
  cooldown: { active: boolean; retryAfterMs: number };
  positions: { symbol: string; side: "Buy" | "Sell"; size: number; unrealisedPnl: number }[];
}

export async function getSnapshot(ctx: Ctx, caller: Caller): Promise<Snapshot> {
  const nowMs = ctx.now();
  const limits = await ctx.store.getLimits(caller.userId);
  let positions: OpenPosition[];
  let realized: number;
  try {
    const ex = ctx.exchange();
    [positions, realized] = await Promise.all([ex.getPositions(caller.userId), ex.getRealizedSince(caller.userId, utcDayStart(nowMs))]);
  } catch (e) {
    throw exchangeFailure(e);
  }
  const unrealized = positions.reduce((s, p) => s + p.unrealisedPnl, 0);

  const lastAction = limits.last_action_at ? Date.parse(limits.last_action_at) : null;
  const cd = checkCooldown(lastAction, nowMs);

  let state: SnapshotState = "NO_LIMIT";
  let used: number | null = null;
  let left: number | null = null;
  let fraction: number | null = null;
  let limit: number | null = null;
  if (limits.daily_limit !== null) {
    let risk;
    try {
      risk = computeRisk({ limit: Number(limits.daily_limit), realizedPnl: realized, unrealizedPnl: unrealized });
    } catch {
      throw new ApiError(502, "bad_pnl", "Could not compute risk from the exchange data.");
    }
    state = risk.state;
    used = risk.used;
    left = risk.left;
    fraction = risk.fraction;
    limit = risk.limit;
    const day = new Date(utcDayStart(nowMs)).toISOString().slice(0, 10);
    await ctx.store.upsertSession(caller.userId, day, risk.limit, risk.state === "TRIPPED").catch(() => {});
  }

  return {
    asOf: new Date(nowMs).toISOString(),
    state,
    limit,
    used,
    left,
    fraction,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    killSwitch: limits.kill_switch,
    cooldown: { active: !cd.allowed, retryAfterMs: cd.retryAfterMs },
    positions: positions.map((p) => ({ symbol: p.symbol, side: p.side, size: p.size, unrealisedPnl: p.unrealisedPnl })),
  };
}

// ---------------------------------------------------------------------------
// Settings (write)
// ---------------------------------------------------------------------------

export async function setLimit(ctx: Ctx, caller: Caller, value: unknown): Promise<{ limit: number }> {
  let amount: number;
  try {
    amount = validateLimit(value);
  } catch {
    throw new ApiError(400, "bad_limit", "Limit must be a number between 1 and 1,000,000 USD.");
  }
  const before = await ctx.store.getLimits(caller.userId);
  // Raising the limit is the one write that weakens the guard. From the glasses (device token,
  // possibly by voice) it is refused while the account is CLOSING IN or TRIPPED, and refused if
  // the state cannot be determined: that is exactly when someone would raise it to dodge the guard.
  if (caller.via === "device" && before.daily_limit !== null && amount > Number(before.daily_limit)) {
    const snap = await getSnapshot(ctx, caller);
    if (snap.state === "CLOSING" || snap.state === "TRIPPED") {
      await ctx.store.logAction({
        user_id: caller.userId, device_id: caller.deviceId, kind: "set_limit", status: "rejected", reason: "raise_blocked",
        detail: { from: before.daily_limit, to: amount, state: snap.state, via: caller.via },
      }).catch(() => {});
      throw new ApiError(403, "raise_blocked", "Raising the limit is blocked from the glasses while you are close to it or past it. Use the website.");
    }
  }
  await ctx.store.setLimit(caller.userId, amount);
  await ctx.store.logAction({
    user_id: caller.userId,
    device_id: caller.deviceId,
    kind: "set_limit",
    status: "executed",
    detail: { from: before.daily_limit, to: amount, via: caller.via },
  });
  return { limit: amount };
}

export async function setKillSwitch(ctx: Ctx, caller: Caller, on: unknown): Promise<{ killSwitch: boolean }> {
  if (typeof on !== "boolean") throw new ApiError(400, "bad_request", "killSwitch must be true or false.");
  // The kill switch is a web-settings control only; the glasses cannot turn writes back on.
  if (caller.via !== "user") throw new ApiError(403, "forbidden", "The kill switch can only be changed from the website.");
  await ctx.store.setKillSwitch(caller.userId, on);
  await ctx.store.logAction({ user_id: caller.userId, device_id: null, kind: "kill_switch", status: "executed", detail: { on } });
  return { killSwitch: on };
}

// ---------------------------------------------------------------------------
// Act: propose -> confirm
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProposalView {
  proposalId: string;
  kind: ActionKind;
  expiresInSeconds: number;
  orders: { symbol: string; side: "Buy" | "Sell"; qty: string }[];
}

export async function propose(ctx: Ctx, caller: Caller, kindRaw: unknown): Promise<ProposalView | { dismissed: true }> {
  try {
    return await proposeInner(ctx, caller, kindRaw);
  } catch (e) {
    // Every refusal at the propose step (kill switch, cooldown, no positions, no prices) is written to
    // the actions log too, so the record shows attempts, not only executions. Malformed input (400) is not logged.
    if (e instanceof ApiError && e.status !== 400 && isActionKind(kindRaw) && kindRaw !== "dismiss") {
      await ctx.store.logAction({
        user_id: caller.userId, device_id: caller.deviceId, kind: kindRaw, status: "rejected", reason: e.code, detail: { stage: "propose", via: caller.via },
      }).catch(() => {});
    }
    throw e;
  }
}

async function proposeInner(ctx: Ctx, caller: Caller, kindRaw: unknown): Promise<ProposalView | { dismissed: true }> {
  if (!isActionKind(kindRaw)) throw new ApiError(400, "bad_kind", "Unknown action.");
  const kind = kindRaw;

  if (kind === "dismiss") {
    await ctx.store.logAction({ user_id: caller.userId, device_id: caller.deviceId, kind: "dismiss", status: "executed" });
    return { dismissed: true };
  }

  const limits = await ctx.store.getLimits(caller.userId);
  if (limits.kill_switch) throw new ApiError(403, "kill_switch", "Write actions are switched off in settings.");
  const cd = checkCooldown(limits.last_action_at ? Date.parse(limits.last_action_at) : null, ctx.now());
  if (!cd.allowed) throw new ApiError(429, "cooldown", "Please wait before the next action.", { retryAfterMs: cd.retryAfterMs });

  let positions: OpenPosition[];
  const instruments: Record<string, Instrument | undefined> = {};
  try {
    const ex = ctx.exchange();
    positions = await ex.getPositions(caller.userId);
    for (const sym of new Set(positions.map((p) => p.symbol))) {
      try {
        const inst = await ex.getInstrument(sym);
        if (inst.status === "Trading") instruments[sym] = { qtyStep: inst.qtyStep, minOrderQty: inst.minOrderQty };
      } catch (e) {
        if (!(e instanceof ExchangeError && e.kind === "unsupported_symbol")) throw e;
      }
    }
  } catch (e) {
    throw exchangeFailure(e);
  }
  if (positions.length === 0) throw new ApiError(409, "no_positions", "There are no open positions to reduce.");

  const plan = planReduction(kind, positions as Position[], instruments);
  if (plan.orders.length === 0) {
    throw new ApiError(409, "nothing_to_reduce", "No position can be reduced by that amount.", { skipped: plan.skipped });
  }

  const expiresAt = new Date(ctx.now() + PROPOSAL_TTL_MS).toISOString();
  const proposalId = await ctx.store.insertProposal({
    user_id: caller.userId,
    device_id: caller.deviceId,
    kind,
    orders: plan.orders,
    expires_at: expiresAt,
  });
  return {
    proposalId,
    kind,
    expiresInSeconds: Math.floor(PROPOSAL_TTL_MS / 1000),
    orders: plan.orders.map((o) => ({ symbol: o.symbol, side: o.side, qty: o.qty })),
  };
}

export interface ConfirmResult {
  executed: number;
  failed: number;
  results: { symbol: string; qty: string; status: "executed" | "failed"; orderId?: string; reason?: string }[];
}

export async function confirm(ctx: Ctx, caller: Caller, proposalId: unknown, kindRaw: unknown): Promise<ConfirmResult> {
  if (typeof proposalId !== "string" || !UUID_RE.test(proposalId)) throw new ApiError(400, "bad_request", "Invalid proposal.");
  if (!isActionKind(kindRaw) || kindRaw === "dismiss") throw new ApiError(400, "bad_kind", "Unknown action.");
  const kind = kindRaw;

  const reject = async (reason: string, status: number, message: string, extra: Record<string, unknown> = {}) => {
    await ctx.store.logAction({
      user_id: caller.userId, device_id: caller.deviceId, proposal_id: proposalId, kind, status: "rejected", reason,
    }).catch(() => {});
    return new ApiError(status, reason, message, extra);
  };

  // 1) consume the proposal exactly once (atomic in the database)
  const consumed = await ctx.store.consumeProposal(proposalId, caller.userId, kind, MIN_CONFIRM_DELAY_MS);
  if (!consumed.ok || !consumed.orders) {
    const reason = consumed.reason ?? "missing";
    const messages: Record<string, [number, string]> = {
      missing: [404, "No such pending action."],
      consumed: [409, "This action was already confirmed."],
      expired: [410, "The confirmation expired. Start again."],
      kind_mismatch: [409, "That does not match the pending action."],
      too_soon: [425, "Confirmed too fast. Press again to confirm."],
    };
    const [status, message] = messages[reason] ?? [409, "Cannot confirm."];
    throw await reject(reason, status, message);
  }

  // 2) claim the single action slot (cooldown + kill switch, atomic in the database)
  const claim = await ctx.store.claimSlot(caller.userId, COOLDOWN_MS / 1000);
  if (!claim.ok) {
    if (claim.reason === "kill_switch") throw await reject("kill_switch", 403, "Write actions are switched off in settings.");
    throw await reject("cooldown", 429, "Please wait before the next action.", { retryAfterMs: claim.retry_after_seconds * 1000 });
  }

  // 3) place reduce-only orders, one by one, logging each leg
  const results: ConfirmResult["results"] = [];
  let ex: ExchangeAdapter | null = null;
  try {
    ex = ctx.exchange();
  } catch (e) {
    // exchange unavailable: nothing was placed, give the slot back
    await ctx.store.releaseSlot(caller.userId, claim.claimed_at!, claim.previous).catch(() => {});
    throw exchangeFailure(e);
  }
  for (let i = 0; i < consumed.orders.length; i++) {
    const order = consumed.orders[i]!;
    try {
      const r = await ex.placeReduceOnlyMarket(caller.userId, order, `hl-${proposalId.slice(0, 8)}-${i}`);
      results.push({ symbol: order.symbol, qty: order.qty, status: "executed", orderId: r.orderId });
      await ctx.store.logAction({
        user_id: caller.userId, device_id: caller.deviceId, proposal_id: proposalId, kind, status: "executed",
        symbol: order.symbol, side: order.side, size: Number(order.qty), detail: { orderId: r.orderId, via: caller.via },
      }).catch(() => {});
    } catch (e) {
      const err = exchangeFailure(e);
      const reason = typeof err.extra.retCode === "number" ? `${err.code}:${err.extra.retCode}` : err.code;
      results.push({ symbol: order.symbol, qty: order.qty, status: "failed", reason });
      await ctx.store.logAction({
        user_id: caller.userId, device_id: caller.deviceId, proposal_id: proposalId, kind, status: "failed", reason,
        symbol: order.symbol, side: order.side, size: Number(order.qty), detail: { via: caller.via },
      }).catch(() => {});
    }
  }

  const executed = results.filter((r) => r.status === "executed").length;
  // If nothing executed, the user is not locked out of retrying.
  if (executed === 0) await ctx.store.releaseSlot(caller.userId, claim.claimed_at!, claim.previous).catch(() => {});
  return { executed, failed: results.length - executed, results };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

const PAIRING_TTL_SECONDS = 600;
const PAIRING_MAX_PENDING = 200;

/** Uniformly random 6-digit code (rejection sampling, no modulo bias). */
export function randomCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % 1_000_000).padStart(6, "0");
  }
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pairStart(
  store: Store,
  hash: (t: string) => Promise<string>,
  ipHash: string | null = null,
): Promise<{ code: string; token: string; expiresInSeconds: number }> {
  const token = randomToken();
  const tokenHash = await hash(token);
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const r = await store.startPairing(code, tokenHash, PAIRING_TTL_SECONDS, PAIRING_MAX_PENDING, ipHash);
    if (r.ok) return { code, token, expiresInSeconds: PAIRING_TTL_SECONDS };
    if (r.reason === "ip_limited") throw new ApiError(429, "rate_limited", "Too many pairing codes requested from your network. Try again later.");
    if (r.reason === "busy") throw new ApiError(503, "pairing_busy", "Pairing is busy. Try again in a minute.");
  }
  throw new ApiError(503, "pairing_busy", "Could not allocate a pairing code. Try again.");
}

export async function pairClaim(store: Store, caller: Caller, code: unknown): Promise<{ paired: true }> {
  if (caller.via !== "user") throw new ApiError(403, "forbidden", "Enter the code on the website while signed in.");
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) {
    // malformed input still counts against the attempt budget, via the same atomic path
    await store.claimPairing(caller.userId, "000000x").catch(() => {});
    throw new ApiError(400, "invalid_code", "Enter the 6-digit code shown on your glasses.");
  }
  const r = await store.claimPairing(caller.userId, code);
  if (r.reason === "rate_limited") throw new ApiError(429, "rate_limited", "Too many wrong codes. Wait a few minutes and try again.");
  if (!r.ok) throw new ApiError(400, "invalid_code", "That code is wrong or has expired.");
  return { paired: true };
}

/** Removes a paired device (e.g. lost glasses). Website session only; the device token stops working at once. */
export async function revokeDevice(store: Store, caller: Caller, deviceId: unknown): Promise<{ revoked: true }> {
  if (caller.via !== "user") throw new ApiError(403, "forbidden", "Devices are removed from the website.");
  if (typeof deviceId !== "string" || !UUID_RE.test(deviceId)) throw new ApiError(400, "bad_request", "Invalid device.");
  if (!(await store.revokeDevice(caller.userId, deviceId))) throw new ApiError(404, "not_found", "No such device.");
  return { revoked: true };
}
