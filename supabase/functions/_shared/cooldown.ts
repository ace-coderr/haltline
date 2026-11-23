// Cooldown and two-step confirmation. Pure decision logic; the database makes the
// same decisions atomically (see migrations: claim_action_slot, consume_proposal)
// so that two concurrent requests cannot both pass.

import type { ActionKind } from "./actions.ts";

/** At most one executed write action per window. */
export const COOLDOWN_MS = 60_000;
/** A proposal can be confirmed for this long after it is created. */
export const PROPOSAL_TTL_MS = 20_000;
/** A confirm arriving sooner than this after the proposal is treated as a stray press. */
export const MIN_CONFIRM_DELAY_MS = 800;

export interface CooldownResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * `lastExecutedAtMs` is the time of the last EXECUTED write action, or null for none.
 * If the clock appears to have gone backwards we fail closed.
 */
export function checkCooldown(
  lastExecutedAtMs: number | null,
  nowMs: number,
  windowMs: number = COOLDOWN_MS,
): CooldownResult {
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs < 0) {
    return { allowed: false, retryAfterMs: COOLDOWN_MS };
  }
  if (lastExecutedAtMs === null) return { allowed: true, retryAfterMs: 0 };
  if (!Number.isFinite(lastExecutedAtMs) || nowMs < lastExecutedAtMs) {
    return { allowed: false, retryAfterMs: windowMs };
  }
  const elapsed = nowMs - lastExecutedAtMs;
  if (elapsed >= windowMs) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: windowMs - elapsed };
}

export interface Proposal {
  id: string;
  kind: ActionKind;
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
}

export function createProposal(id: string, kind: ActionKind, nowMs: number): Proposal {
  return {
    id,
    kind,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + PROPOSAL_TTL_MS,
    consumedAtMs: null,
  };
}

export type ConfirmResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "kind_mismatch" | "too_soon" | "bad_clock" };

export function validateConfirm(
  proposal: Proposal | null | undefined,
  requestedKind: ActionKind,
  nowMs: number,
): ConfirmResult {
  if (!proposal) return { ok: false, reason: "missing" };
  if (!Number.isFinite(nowMs) || nowMs < proposal.createdAtMs) return { ok: false, reason: "bad_clock" };
  if (proposal.consumedAtMs !== null) return { ok: false, reason: "consumed" };
  if (nowMs >= proposal.expiresAtMs) return { ok: false, reason: "expired" };
  if (proposal.kind !== requestedKind) return { ok: false, reason: "kind_mismatch" };
  if (nowMs - proposal.createdAtMs < MIN_CONFIRM_DELAY_MS) return { ok: false, reason: "too_soon" };
  return { ok: true };
}

/** Dismiss never touches the exchange, so it needs no confirmation or cooldown. */
export function requiresConfirmation(kind: ActionKind): boolean {
  return kind !== "dismiss";
}
