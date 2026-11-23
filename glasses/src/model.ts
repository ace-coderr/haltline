// Pure application model for the glasses: state, events, a reducer that returns effects,
// and buildScreen() which turns state into exactly what the display shows.
// No DOM, no SDK, no network: everything here is unit-tested.
//
// Inputs used: press (click), swipe up, swipe down. Double press is NEVER an action: the
// platform uses it to exit the app, so this model has no handler for it.

import { emptyGauge, gaugeString } from './gauge.ts'

export type ActionKind = 'cut_half' | 'cut_all' | 'dismiss'
export const MENU: readonly ActionKind[] = ['cut_half', 'cut_all', 'dismiss']

/** A press this soon after the confirm screen appeared is treated as a stray press. */
export const MIN_CONFIRM_MS = 900
/** Ignore swipe/press bursts closer together than this (one swipe can emit several events). */
export const INPUT_DEBOUNCE_MS = 250
/** After this long without a good reply, live numbers are replaced by an offline screen. */
export const STALE_AFTER_MS = 15_000
export const NOTICE_MS = 4_000

export type RiskState = 'CALM' | 'CLOSING' | 'TRIPPED'

export interface Snapshot {
  asOf: string
  state: RiskState | 'NO_LIMIT'
  limit: number | null
  used: number | null
  left: number | null
  fraction: number | null
  killSwitch: boolean
  cooldown: { active: boolean; retryAfterMs: number }
  positions: { symbol: string; side: 'Buy' | 'Sell'; size: number; unrealisedPnl: number }[]
}

export interface Proposal {
  proposalId: string
  kind: Exclude<ActionKind, 'dismiss'>
  orders: { symbol: string; side: 'Buy' | 'Sell'; qty: string }[]
  shownAt: number
  expiresAt: number
}

export type ProblemKind = 'offline' | 'prices' | 'server'
export interface Problem {
  kind: ProblemKind
  since: number
}

export interface AppState {
  phase: 'boot' | 'pairing' | 'ready'
  pairing: { code: string; expiresAt: number } | null
  snapshot: Snapshot | null
  lastOkAt: number | null
  problem: Problem | null
  menu: { open: boolean; index: number }
  /** True once the user dismissed the current TRIPPED episode, so the menu does not reopen. */
  dismissedTrip: boolean
  pending: Proposal | null
  busy: 'proposing' | 'confirming' | null
  notice: { text: string; until: number } | null
  lastInputAt: number
}

export const initialState = (): AppState => ({
  phase: 'boot',
  pairing: null,
  snapshot: null,
  lastOkAt: null,
  problem: null,
  menu: { open: false, index: 0 },
  dismissedTrip: false,
  pending: null,
  busy: null,
  notice: null,
  lastInputAt: -Infinity,
})

export type AppEvent =
  | { type: 'pairing_code'; code: string; expiresAt: number }
  | { type: 'paired' }
  | { type: 'unpaired' }
  | { type: 'snapshot'; snapshot: Snapshot; at: number }
  | { type: 'snapshot_failed'; problem: ProblemKind; at: number }
  | { type: 'swipe'; dir: 'up' | 'down'; at: number }
  | { type: 'press'; at: number }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'dismissed'; at: number }
  | { type: 'action_failed'; text: string; at: number }
  | { type: 'confirmed'; text: string; at: number }
  | { type: 'tick'; at: number }

export type Effect =
  | { type: 'propose'; kind: ActionKind }
  | { type: 'confirm'; proposalId: string; kind: Exclude<ActionKind, 'dismiss'> }
  | { type: 'refresh' }

export interface Update {
  state: AppState
  effects: Effect[]
}

const noop = (state: AppState): Update => ({ state, effects: [] })
const withNotice = (s: AppState, text: string, at: number): AppState => ({ ...s, notice: { text, until: at + NOTICE_MS } })

export function update(prev: AppState, ev: AppEvent): Update {
  switch (ev.type) {
    case 'pairing_code':
      return noop({ ...prev, phase: 'pairing', pairing: { code: ev.code, expiresAt: ev.expiresAt } })

    case 'paired':
      return { state: { ...prev, phase: 'ready', pairing: null }, effects: [{ type: 'refresh' }] }

    case 'unpaired':
      return noop({ ...initialState(), phase: 'boot' })

    case 'snapshot': {
      let s: AppState = { ...prev, phase: 'ready', snapshot: ev.snapshot, lastOkAt: ev.at, problem: null }
      if (ev.snapshot.state !== 'TRIPPED' && prev.dismissedTrip) s = { ...s, dismissedTrip: false }
      // A new TRIPPED episode opens the action menu by itself, preselecting CUT HALF.
      if (ev.snapshot.state === 'TRIPPED' && !s.dismissedTrip && !s.menu.open && !s.pending && !s.busy) {
        s = { ...s, menu: { open: true, index: 0 } }
      }
      // Back under the limit: nothing to act on, close a menu that opened for the trip.
      if (ev.snapshot.state !== 'TRIPPED' && s.menu.open && prev.snapshot?.state === 'TRIPPED' && !s.pending) {
        s = { ...s, menu: { open: false, index: 0 } }
      }
      return noop(s)
    }

    case 'snapshot_failed': {
      const problem: Problem = prev.problem && prev.problem.kind === ev.problem ? prev.problem : { kind: ev.problem, since: ev.at }
      return noop({ ...prev, problem })
    }

    case 'swipe': {
      if (prev.phase !== 'ready' || prev.busy) return noop(prev)
      if (ev.at - prev.lastInputAt < INPUT_DEBOUNCE_MS) return noop(prev)
      const base = { ...prev, lastInputAt: ev.at }
      if (prev.pending) return noop({ ...base, pending: null, notice: null }) // swipe cancels the confirm step
      if (!prev.menu.open) return noop(base)
      // Direction is deliberately ignored: how the glasses map scroll events to swipe up/down is not
      // documented and not verified on hardware, so ANY swipe advances to the next option. Every
      // option is reachable in at most two swipes, and a wrong guess cannot select anything.
      const index = (prev.menu.index + 1) % MENU.length
      return noop({ ...base, menu: { open: true, index } })
    }

    case 'press': {
      if (prev.phase !== 'ready' || prev.busy) return noop(prev)
      if (ev.at - prev.lastInputAt < INPUT_DEBOUNCE_MS) return noop(prev)
      const base = { ...prev, lastInputAt: ev.at }
      if (isBlocked(prev, ev.at)) return noop(base)

      if (prev.pending) {
        if (ev.at - prev.pending.shownAt < MIN_CONFIRM_MS) return noop(base) // stray press
        if (ev.at >= prev.pending.expiresAt) return noop(withNotice({ ...base, pending: null }, 'EXPIRED', ev.at))
        return { state: { ...base, busy: 'confirming' }, effects: [{ type: 'confirm', proposalId: prev.pending.proposalId, kind: prev.pending.kind }] }
      }

      if (!prev.menu.open) return noop({ ...base, menu: { open: true, index: 0 } })

      const kind = MENU[prev.menu.index] ?? 'dismiss'
      const snap = prev.snapshot
      if (kind === 'dismiss') {
        return { state: { ...base, busy: 'proposing', menu: { open: false, index: 0 } }, effects: [{ type: 'propose', kind }] }
      }
      if (snap?.killSwitch) return noop(withNotice(base, 'WRITES OFF', ev.at))
      if (snap && snap.cooldown.active) {
        return noop(withNotice(base, `WAIT ${Math.max(1, Math.ceil(snap.cooldown.retryAfterMs / 1000))}s`, ev.at))
      }
      if (snap && snap.positions.length === 0) return noop(withNotice(base, 'NO POSITIONS', ev.at))
      return { state: { ...base, busy: 'proposing' }, effects: [{ type: 'propose', kind }] }
    }

    case 'proposal':
      return noop({ ...prev, busy: null, pending: ev.proposal })

    case 'dismissed':
      return noop(withNotice({ ...prev, busy: null, dismissedTrip: prev.snapshot?.state === 'TRIPPED' ? true : prev.dismissedTrip }, 'DISMISSED', ev.at))

    case 'action_failed':
      return noop(withNotice({ ...prev, busy: null, pending: null }, ev.text, ev.at))

    case 'confirmed':
      return {
        state: withNotice({ ...prev, busy: null, pending: null, menu: { open: false, index: 0 } }, ev.text, ev.at),
        effects: [{ type: 'refresh' }],
      }

    case 'tick': {
      let s = prev
      if (s.notice && ev.at >= s.notice.until) s = { ...s, notice: null }
      if (s.pending && ev.at >= s.pending.expiresAt && !s.busy) s = withNotice({ ...s, pending: null }, 'EXPIRED', ev.at)
      return s === prev ? noop(prev) : noop(s)
    }
  }
}

/** While offline or priceless the user must not be able to start an action. */
function isBlocked(s: AppState, at: number): boolean {
  if (!s.problem) return false
  return s.lastOkAt === null || at - s.lastOkAt > STALE_AFTER_MS
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export interface Screen {
  kind: 'loading' | 'pairing' | 'offline' | 'prices' | 'no_limit' | 'state' | 'menu' | 'confirm' | 'notice'
  /** Small line at the top. Always starts with PAPER. */
  status: string
  /** The giant text, drawn into the two image containers. */
  big: string
  /** Gauge fraction 0..1, or null for no gauge. */
  gauge: number | null
  /** Blink the gauge/status at a safe rate (TRIPPED only). */
  pulse: boolean
  sub: string
  hint: string
}

export function formatUsdWhole(usd: number): string {
  if (!Number.isFinite(usd)) return '$--'
  const whole = Math.floor(Math.max(0, usd) + 1e-9)
  return '$' + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const spaced = (code: string): string => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code)

function menuLine(index: number): string {
  const label = (k: ActionKind): string => ({ cut_half: 'cut half', cut_all: 'cut all', dismiss: 'dismiss' })[k]
  return MENU.map((k, i) => (i === index ? `■ ${label(k).toUpperCase()}?` : `□ ${label(k)}`)).join('   ')
}

/** e.g. "BUY 1.500 ETHUSD · reduces short". A reduce-only Buy closes part of a short; a Sell, a long. */
export function orderLine(orders: Proposal['orders']): string {
  const first = orders[0]
  if (!first) return ''
  const side = first.side === 'Sell' ? 'SELL' : 'BUY'
  const reduces = first.side === 'Sell' ? 'long' : 'short'
  const more = orders.length > 1 ? ` (+${orders.length - 1} more)` : ''
  return `${side} ${first.qty} ${first.symbol} · reduces ${reduces}${more}`
}

const stateWord = (s: Snapshot): string => (s.state === 'NO_LIMIT' ? 'NO LIMIT' : s.state === 'CLOSING' ? 'CLOSING IN' : s.state)

export function buildScreen(s: AppState, now: number): Screen {
  if (s.phase === 'boot') {
    return { kind: 'loading', status: 'PAPER', big: 'HALTLINE', gauge: null, pulse: false, sub: 'Loading…', hint: '' }
  }

  if (s.phase === 'pairing') {
    const left = s.pairing ? Math.max(0, Math.ceil((s.pairing.expiresAt - now) / 1000)) : 0
    const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
    return {
      kind: 'pairing',
      status: 'PAPER · NOT PAIRED',
      big: s.pairing ? spaced(s.pairing.code) : '…',
      gauge: null,
      pulse: false,
      sub: 'Enter this code on the Haltline site: Pair a device',
      hint: s.pairing ? `code expires in ${mm}` : 'getting a code…',
    }
  }

  const snap = s.snapshot
  const stale = s.problem !== null && (s.lastOkAt === null || now - s.lastOkAt > STALE_AFTER_MS)

  // Fail closed: never keep showing an old number as if it were live.
  if (!snap || stale) {
    const known = snap && snap.state !== 'NO_LIMIT' && snap.left !== null && s.lastOkAt !== null
      ? `last seen ${formatUsdWhole(snap.left)} left, ${Math.round((now - s.lastOkAt) / 1000)}s ago`
      : 'No data yet'
    if (s.problem?.kind === 'prices') {
      return { kind: 'prices', status: 'PAPER · NO PRICES', big: 'NO PRICES', gauge: null, pulse: false, sub: 'Live prices are unavailable. Numbers hidden.', hint: 'retrying…' }
    }
    return { kind: 'offline', status: 'PAPER · OFFLINE', big: 'OFFLINE', gauge: null, pulse: false, sub: known, hint: 'retrying…' }
  }

  if (s.notice && now < s.notice.until) {
    return { kind: 'notice', status: 'PAPER', big: s.notice.text, gauge: snap.fraction, pulse: false, sub: '', hint: '' }
  }

  const killed = snap.killSwitch ? ' · WRITES OFF' : ''
  const tripped = snap.state === 'TRIPPED'

  if (s.pending) {
    const o = orderLine(s.pending.orders)
    const secs = Math.max(0, Math.ceil((s.pending.expiresAt - now) / 1000))
    return {
      kind: 'confirm',
      status: `PAPER · CONFIRM${killed}`,
      big: s.pending.kind === 'cut_half' ? 'CUT HALF' : 'CUT ALL',
      gauge: snap.fraction,
      pulse: false,
      sub: o,
      hint: `press: confirm · swipe: cancel · ${secs}s`,
    }
  }

  if (s.menu.open) {
    return {
      kind: 'menu',
      status: `PAPER · ${stateWord(snap)}${killed}`,
      big: tripped ? 'LIMIT REACHED' : 'ACTIONS',
      gauge: snap.fraction,
      pulse: tripped,
      sub: menuLine(s.menu.index),
      hint: 'swipe: change · press: confirm',
    }
  }

  if (snap.state === 'NO_LIMIT' || snap.left === null) {
    return { kind: 'no_limit', status: `PAPER · NO LIMIT${killed}`, big: 'NO LIMIT', gauge: null, pulse: false, sub: 'Set a daily limit on the Haltline site', hint: '' }
  }

  const positions = snap.positions.length === 0 ? ' · no open positions' : ''
  if (tripped) {
    return {
      kind: 'state',
      status: `PAPER · TRIPPED${killed}`,
      big: 'LIMIT REACHED',
      gauge: 1,
      pulse: true,
      sub: 'Dismissed. Press for actions.',
      hint: 'press: actions',
    }
  }
  const used = snap.used ?? 0
  return {
    kind: 'state',
    status: `PAPER · ${stateWord(snap)}${killed}`,
    big: formatUsdWhole(snap.left),
    gauge: snap.fraction,
    pulse: false,
    sub: `left to lose today${snap.state === 'CLOSING' ? ' · CLOSE' : ''}${positions}`,
    hint: `limit ${formatUsdWhole(snap.limit ?? 0)} · used ${formatUsdWhole(used)} · press: actions`,
  }
}

/** The gauge text for a screen, honouring the pulse phase (true = visible half). */
export function gaugeText(screen: Screen, shown: number, pulseOn: boolean): string {
  if (screen.gauge === null) return ''
  if (screen.pulse && !pulseOn) return emptyGauge()
  return gaugeString(screen.pulse ? 1 : shown)
}
