import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  type AppEvent, type AppState, buildScreen, formatUsdWhole, gaugeText, initialState, INPUT_DEBOUNCE_MS, MIN_CONFIRM_MS,
  orderLine, type Proposal, type Snapshot, STALE_AFTER_MS, update,
} from './model.ts'
import { emptyGauge, filledCells, GAUGE_CELLS, gaugeString, stepGauge } from './gauge.ts'

const T = 1_000_000
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  asOf: 'x', state: 'CALM', limit: 500, used: 88, left: 412, fraction: 0.176, killSwitch: false,
  cooldown: { active: false, retryAfterMs: 0 },
  positions: [{ symbol: 'ETHUSD', side: 'Buy', size: 2, unrealisedPnl: -88 }], ...o,
})
const tripped = (): Snapshot => snap({ state: 'TRIPPED', used: 510, left: 0, fraction: 1 })
const closing = (): Snapshot => snap({ state: 'CLOSING', used: 404, left: 96, fraction: 0.808 })

function run(events: AppEvent[], from: AppState = initialState()) {
  let state = from
  const effects: ReturnType<typeof update>['effects'] = []
  for (const e of events) {
    const u = update(state, e)
    state = u.state
    effects.push(...u.effects)
  }
  return { state, effects }
}
const ready = (s: Snapshot, at = T): AppState => run([{ type: 'paired' }, { type: 'snapshot', snapshot: s, at }]).state
const proposal = (shownAt: number): Proposal => ({
  proposalId: 'p1', kind: 'cut_half', orders: [{ symbol: 'ETHUSD', side: 'Sell', qty: '1.000' }], shownAt, expiresAt: shownAt + 20_000,
})

// ------------------------------------------------------------------ gauge

test('gauge: fills, never shows empty once anything is used, full only at the limit', () => {
  assert.equal(filledCells(0), 0)
  assert.equal(filledCells(0.001), 1)
  assert.equal(filledCells(0.5), Math.round(GAUGE_CELLS / 2))
  assert.equal(filledCells(0.999), GAUGE_CELLS - 1)
  assert.equal(filledCells(1), GAUGE_CELLS)
  assert.equal(filledCells(7), GAUGE_CELLS)
  assert.equal(filledCells(NaN), 0)
  assert.equal(gaugeString(0.5).length, GAUGE_CELLS)
  assert.equal(emptyGauge().length, GAUGE_CELLS)
})

test('gauge animation moves toward the target at a bounded rate and lands exactly', () => {
  let v = 0
  for (let i = 0; i < 100; i++) v = stepGauge(v, 0.8, 100, 1)
  assert.equal(v, 0.8)
  assert.equal(stepGauge(0.1, 0.9, 100, 1), 0.2)
  assert.equal(stepGauge(0.9, 0.1, 100, 1), 0.8)
  assert.equal(stepGauge(0.5, NaN, 100), 0.5)
})

// ------------------------------------------------------------------ formatting

test('formatUsdWhole rounds down so headroom is never overstated', () => {
  assert.equal(formatUsdWhole(412), '$412')
  assert.equal(formatUsdWhole(95.99), '$95')
  assert.equal(formatUsdWhole(1234.5), '$1,234')
  assert.equal(formatUsdWhole(-3), '$0')
  assert.equal(formatUsdWhole(NaN), '$--')
})

// ------------------------------------------------------------------ the three states

test('CALM shows the giant distance to the limit', () => {
  const s = buildScreen(ready(snap()), T)
  assert.equal(s.kind, 'state')
  assert.equal(s.big, '$412')
  assert.equal(s.sub, 'left to lose today')
  assert.ok(s.status.startsWith('PAPER'))
  assert.equal(s.pulse, false)
  assert.ok(Math.abs((s.gauge ?? 0) - 0.176) < 1e-9)
})

test('CLOSING IN reads "$96 left to lose today · CLOSE"', () => {
  const s = buildScreen(ready(closing()), T)
  assert.equal(s.big, '$96')
  assert.equal(s.sub, 'left to lose today · CLOSE')
  assert.ok(s.status.includes('CLOSING IN'))
})

test('TRIPPED shows LIMIT REACHED, CUT HALF?, and the swipe/press hint, and pulses', () => {
  const s = buildScreen(ready(tripped()), T)
  assert.equal(s.kind, 'menu')
  assert.equal(s.big, 'LIMIT REACHED')
  assert.ok(s.sub.includes('■ CUT HALF?'))
  assert.equal(s.hint, 'swipe: change · press: confirm')
  assert.equal(s.pulse, true)
  assert.equal(s.gauge, 1)
})

test('empty account is an honest sub-line, not a fake number', () => {
  const s = buildScreen(ready(snap({ positions: [], used: 0, left: 500, fraction: 0 })), T)
  assert.equal(s.big, '$500')
  assert.ok(s.sub.includes('no open positions'))
})

test('NO_LIMIT asks for a limit instead of showing a number', () => {
  const s = buildScreen(ready(snap({ state: 'NO_LIMIT', limit: null, used: null, left: null, fraction: null })), T)
  assert.equal(s.kind, 'no_limit')
  assert.equal(s.gauge, null)
})

test('every screen is labelled PAPER', () => {
  const states = [initialState(), ready(snap()), ready(closing()), ready(tripped()),
    run([{ type: 'pairing_code', code: '123456', expiresAt: T + 600_000 }]).state]
  for (const st of states) assert.ok(buildScreen(st, T).status.startsWith('PAPER'))
})

test('the pulse alternates the gauge at the screen level', () => {
  const s = buildScreen(ready(tripped()), T)
  assert.equal(gaugeText(s, 1, true), gaugeString(1))
  assert.equal(gaugeText(s, 1, false), emptyGauge())
  const calm = buildScreen(ready(snap()), T)
  assert.equal(gaugeText(calm, 0.176, false), gaugeString(0.176))
})

// ------------------------------------------------------------------ pairing / loading / offline

test('boot shows loading; pairing shows the 6-digit code and its expiry', () => {
  assert.equal(buildScreen(initialState(), T).kind, 'loading')
  const p = buildScreen(run([{ type: 'pairing_code', code: '123456', expiresAt: T + 125_000 }]).state, T)
  assert.deepEqual([p.kind, p.big, p.hint], ['pairing', '123 456', 'code expires in 2:05'])
})

test('pairing completes into a refresh', () => {
  const r = run([{ type: 'pairing_code', code: '123456', expiresAt: T + 1 }, { type: 'paired' }])
  assert.equal(r.state.phase, 'ready')
  assert.deepEqual(r.effects, [{ type: 'refresh' }])
})

test('offline fails closed: after the staleness window the number is replaced, not kept', () => {
  let s = ready(snap())
  s = update(s, { type: 'snapshot_failed', problem: 'offline', at: T + 2000 }).state
  assert.equal(buildScreen(s, T + 5000).big, '$412', 'a brief blip keeps the last good number')
  const later = buildScreen(s, T + STALE_AFTER_MS + 1)
  assert.equal(later.kind, 'offline')
  assert.equal(later.big, 'OFFLINE')
  assert.ok(later.sub.includes('last seen $412 left'))
  assert.equal(JSON.stringify(later).includes('CALM'), false)
})

test('no prices is its own screen and hides numbers', () => {
  let s = ready(snap())
  s = update(s, { type: 'snapshot_failed', problem: 'prices', at: T + 1000 }).state
  const sc = buildScreen(s, T + STALE_AFTER_MS + 10)
  assert.deepEqual([sc.kind, sc.big], ['prices', 'NO PRICES'])
})

test('offline from the start (no data yet) is an offline screen', () => {
  const s = update(run([{ type: 'paired' }]).state, { type: 'snapshot_failed', problem: 'offline', at: T }).state
  assert.equal(buildScreen(s, T).kind, 'offline')
})

test('a successful snapshot clears the problem', () => {
  let s = ready(snap())
  s = update(s, { type: 'snapshot_failed', problem: 'offline', at: T + 1000 }).state
  s = update(s, { type: 'snapshot', snapshot: snap(), at: T + 2000 }).state
  assert.equal(s.problem, null)
})

test('no actions can start while offline or without prices', () => {
  let s = ready(snap())
  s = update(s, { type: 'snapshot_failed', problem: 'offline', at: T + 1000 }).state
  const u = update(s, { type: 'press', at: T + STALE_AFTER_MS + 5000 })
  assert.deepEqual(u.effects, [])
  assert.equal(u.state.menu.open, false)
})

// ------------------------------------------------------------------ input and the action flow

test('press opens the menu in CALM and CLOSING; ANY swipe advances through cut half, cut all, dismiss', () => {
  for (const sn of [snap(), closing()]) {
    for (const dirs of [['down', 'down', 'down'], ['up', 'up', 'up'], ['up', 'down', 'up']] as const) {
      let s = ready(sn)
      s = update(s, { type: 'press', at: T + 1000 }).state
      assert.deepEqual(s.menu, { open: true, index: 0 })
      const seen: number[] = []
      dirs.forEach((dir, i) => {
        s = update(s, { type: 'swipe', dir, at: T + 2000 + i * 1000 }).state
        seen.push(s.menu.index)
      })
      assert.deepEqual(seen, [1, 2, 0], 'direction does not matter and the cycle wraps')
    }
  }
})

test('swipe direction can never select or confirm anything, only move the highlight or cancel', () => {
  let s = ready(tripped())
  for (const dir of ['up', 'down'] as const) {
    const u = update(s, { type: 'swipe', dir, at: T + 5000 })
    assert.deepEqual(u.effects, [])
    s = { ...u.state, lastInputAt: -Infinity }
  }
})

test('confirm line states the intent: which side, what it reduces', () => {
  assert.equal(orderLine([{ symbol: 'ETHUSD', side: 'Buy', qty: '1.500' }]), 'BUY 1.500 ETHUSD · reduces short')
  assert.equal(orderLine([{ symbol: 'ETHUSD', side: 'Sell', qty: '1.000' }]), 'SELL 1.000 ETHUSD · reduces long')
  assert.equal(
    orderLine([{ symbol: 'ETHUSD', side: 'Sell', qty: '1.000' }, { symbol: 'BTCUSD', side: 'Buy', qty: '0.1000' }]),
    'SELL 1.000 ETHUSD · reduces long (+1 more)',
  )
  assert.equal(orderLine([]), '')
  let s = ready(tripped())
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'proposal', proposal: proposal(T + 1500) }).state
  assert.equal(buildScreen(s, T + 1600).sub, 'SELL 1.000 ETHUSD · reduces long')
})

test('swipes on a closed menu do nothing; bursts of swipes within the debounce count once', () => {
  let s = ready(snap())
  assert.equal(update(s, { type: 'swipe', dir: 'down', at: T + 1000 }).state.menu.open, false)
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'swipe', dir: 'down', at: T + 2000 }).state
  s = update(s, { type: 'swipe', dir: 'down', at: T + 2000 + INPUT_DEBOUNCE_MS - 1 }).state
  assert.equal(s.menu.index, 1)
})

test('TRIPPED: press proposes CUT HALF; the proposal opens a confirm screen; nothing executes yet', () => {
  let s = ready(tripped())
  let u = update(s, { type: 'press', at: T + 1000 })
  assert.deepEqual(u.effects, [{ type: 'propose', kind: 'cut_half' }])
  assert.equal(u.state.busy, 'proposing')
  s = update(u.state, { type: 'proposal', proposal: proposal(T + 1500) }).state
  const sc = buildScreen(s, T + 1600)
  assert.deepEqual([sc.kind, sc.big], ['confirm', 'CUT HALF'])
  assert.ok(sc.sub.includes('SELL 1.000 ETHUSD'))
  assert.ok(sc.hint.includes('press: confirm'))
  u = update(s, { type: 'tick', at: T + 1600 })
  assert.deepEqual(u.effects, [])
})

test('STRAY PRESS: a press right after the confirm screen appears is ignored', () => {
  let s = ready(tripped())
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'proposal', proposal: proposal(T + 1500) }).state
  const early = update(s, { type: 'press', at: T + 1500 + MIN_CONFIRM_MS - 1 })
  assert.deepEqual(early.effects, [])
  assert.equal(early.state.busy, null)
  const ok = update(early.state, { type: 'press', at: T + 1500 + MIN_CONFIRM_MS + INPUT_DEBOUNCE_MS })
  assert.deepEqual(ok.effects, [{ type: 'confirm', proposalId: 'p1', kind: 'cut_half' }])
})

test('a double press cannot send two confirms (busy blocks the second)', () => {
  let s = ready(tripped())
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'proposal', proposal: proposal(T + 1500) }).state
  const first = update(s, { type: 'press', at: T + 5000 })
  const second = update(first.state, { type: 'press', at: T + 5000 + INPUT_DEBOUNCE_MS + 10 })
  assert.equal(first.effects.length, 1)
  assert.deepEqual(second.effects, [])
})

test('swipe cancels the confirm step and sends nothing', () => {
  let s = ready(tripped())
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'proposal', proposal: proposal(T + 1500) }).state
  const u = update(s, { type: 'swipe', dir: 'down', at: T + 3000 })
  assert.equal(u.state.pending, null)
  assert.deepEqual(u.effects, [])
  assert.equal(buildScreen(u.state, T + 3000).kind, 'menu')
})

test('an expired confirm cannot be confirmed, whether by tick or by a late press', () => {
  let s = ready(tripped())
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'proposal', proposal: proposal(T + 1500) }).state
  const late = update(s, { type: 'press', at: T + 1500 + 20_000 })
  assert.deepEqual(late.effects, [])
  assert.equal(late.state.pending, null)
  const ticked = update(s, { type: 'tick', at: T + 1500 + 20_001 }).state
  assert.equal(ticked.pending, null)
  assert.equal(ticked.notice?.text, 'EXPIRED')
})

test('confirmed: shows the result, closes the menu, refreshes', () => {
  let s = ready(tripped())
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'proposal', proposal: proposal(T + 1500) }).state
  s = update(s, { type: 'press', at: T + 5000 }).state
  const u = update(s, { type: 'confirmed', text: 'DONE · 1 ORDER', at: T + 6000 })
  assert.deepEqual(u.effects, [{ type: 'refresh' }])
  assert.deepEqual([u.state.pending, u.state.busy, u.state.menu.open], [null, null, false])
  assert.equal(buildScreen(u.state, T + 6100).big, 'DONE · 1 ORDER')
  assert.equal(buildScreen(u.state, T + 11_000).big, 'LIMIT REACHED', 'the notice disappears by itself after its time')
})

test('server refusals (cooldown, kill switch) surface as a notice and clear the confirm', () => {
  let s = ready(tripped())
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'action_failed', text: 'WAIT 42s', at: T + 2000 }).state
  assert.deepEqual([s.busy, s.pending, s.notice?.text], [null, null, 'WAIT 42s'])
})

test('local pre-checks: kill switch, cooldown and empty account never reach the server', () => {
  const press = (sn: Snapshot) => update(update(ready(sn), { type: 'press', at: T + 1000 }).state, { type: 'press', at: T + 2000 })
  const killed = press(tripped() && snap({ ...tripped(), killSwitch: true }))
  assert.deepEqual([killed.effects, killed.state.notice?.text], [[], 'WRITES OFF'])
  const cooling = press(snap({ ...tripped(), cooldown: { active: true, retryAfterMs: 41_200 } }))
  assert.deepEqual([cooling.effects, cooling.state.notice?.text], [[], 'WAIT 42s'])
  const empty = press(snap({ ...tripped(), positions: [] }))
  assert.deepEqual([empty.effects, empty.state.notice?.text], [[], 'NO POSITIONS'])
})

test('dismiss is logged through the server, closes the menu, and does not reopen it for this TRIPPED episode', () => {
  let s = ready(tripped())
  s = update(s, { type: 'swipe', dir: 'down', at: T + 1000 }).state // cut all
  s = update(s, { type: 'swipe', dir: 'down', at: T + 2000 }).state // dismiss
  const u = update(s, { type: 'press', at: T + 3000 })
  assert.deepEqual(u.effects, [{ type: 'propose', kind: 'dismiss' }])
  let d = update(u.state, { type: 'dismissed', at: T + 3500 }).state
  d = update(d, { type: 'snapshot', snapshot: tripped(), at: T + 4000 }).state
  assert.equal(d.menu.open, false, 'does not reopen while still tripped')
  const screen = buildScreen(update(d, { type: 'tick', at: T + 9000 }).state, T + 9000)
  assert.equal(screen.big, 'LIMIT REACHED')
  assert.equal(screen.pulse, true)
  // recovering and tripping again is a new episode
  d = update(d, { type: 'snapshot', snapshot: snap(), at: T + 10_000 }).state
  d = update(d, { type: 'snapshot', snapshot: tripped(), at: T + 11_000 }).state
  assert.equal(d.menu.open, true)
})

test('the model has no handler for a double press (the platform exits the app on it)', () => {
  const events = ['pairing_code', 'paired', 'unpaired', 'snapshot', 'snapshot_failed', 'swipe', 'press', 'proposal', 'dismissed', 'action_failed', 'confirmed', 'tick']
  assert.ok(!events.some((e) => /double/i.test(e)))
})

test('a snapshot arriving while a confirm is pending does not discard it', () => {
  let s = ready(tripped())
  s = update(s, { type: 'press', at: T + 1000 }).state
  s = update(s, { type: 'proposal', proposal: proposal(T + 1500) }).state
  s = update(s, { type: 'snapshot', snapshot: tripped(), at: T + 3000 }).state
  assert.equal(s.pending?.proposalId, 'p1')
})

test('an unpair (token rejected) resets to boot so pairing restarts', () => {
  const s = update(ready(snap()), { type: 'unpaired' }).state
  assert.equal(s.phase, 'boot')
  assert.equal(s.snapshot, null)
})
