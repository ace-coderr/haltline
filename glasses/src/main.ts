// Haltline glasses app. Wires the pure model (model.ts) to the glasses (render.ts), the
// backend (api.ts) and the input events. Inputs: press, swipe up, swipe down.
// Double press is deliberately not handled as an action: the platform uses it to exit.

import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { ApiFail, confirmText, createApi, failText } from './api.ts'
import { CONFIGURED, SUPABASE_ANON_KEY, SUPABASE_URL, TOKEN_STORAGE_KEY } from './config.ts'
import { stepGauge } from './gauge.ts'
import {
  type AppEvent, buildScreen, type Effect, formatUsdWhole, gaugeText, initialState, MIN_SPEECH_MS, type Proposal, type Screen, update,
} from './model.ts'
import { concatChunks, pcmDurationMs, pcmToWav } from './wav.ts'
import { Renderer } from './render.ts'

const REFRESH_MS = 5000
const PAIR_POLL_MS = 3000
const PULSE_MS = 800 // on for 0.8 s, off for 0.8 s: 0.6 Hz, well under any flash-rate concern
const FRAME_MS = 125

const bridge = await waitForEvenAppBridge()
const api = createApi({ baseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY })

let state = initialState()
let token: string | null = null
let pairingToken: string | null = null
let foreground = true
let refreshing = false
let gaugeShown = 0
let lastFrameAt = Date.now()

const renderer = new Renderer(bridge)

function toFrame(screen: Screen, now: number) {
  const pulseOn = Math.floor(now / PULSE_MS) % 2 === 0
  return {
    status: screen.status,
    big: screen.big,
    gauge: gaugeText(screen, gaugeShown, pulseOn),
    sub: screen.sub,
    hint: screen.hint,
  }
}

function dispatch(ev: AppEvent): void {
  const u = update(state, ev)
  state = u.state
  for (const fx of u.effects) void run(fx)
  paint()
}

function paint(): void {
  const now = Date.now()
  const screen = buildScreen(state, now)
  const target = screen.gauge ?? 0
  gaugeShown = stepGauge(gaugeShown, target, now - lastFrameAt)
  lastFrameAt = now
  renderer.draw(toFrame(screen, now))
}

// -------------------------------------------------------------------- voice

let pcmChunks: Uint8Array[] = []
let listening = false

async function startListening(): Promise<void> {
  pcmChunks = []
  listening = true
  let ok = false
  try {
    ok = await bridge.audioControl(true)
  } catch {
    ok = false
  }
  if (!ok) {
    listening = false
    dispatch({ type: 'voice_failed', message: 'MIC UNAVAILABLE', heard: null, fallback: true })
  }
}

async function stopListeningAndTranscribe(): Promise<void> {
  listening = false
  try {
    await bridge.audioControl(false)
  } catch { /* the microphone is closed on exit anyway */ }
  const pcm = concatChunks(pcmChunks)
  pcmChunks = []
  if (pcmDurationMs(pcm.byteLength) < MIN_SPEECH_MS) {
    return dispatch({ type: 'voice_failed', message: 'NO SPEECH HEARD', heard: null, fallback: false })
  }
  if (!token) return dispatch({ type: 'voice_failed', message: 'NOT PAIRED', heard: null, fallback: false })
  try {
    const r = await api.transcribe(token, pcmToWav(pcm))
    const heard = r.text
    if (r.command.kind === 'set_limit') return dispatch({ type: 'voice_heard', amount: r.command.amount, heard, at: Date.now() })
    if (r.command.kind === 'out_of_range') return dispatch({ type: 'voice_failed', message: 'LIMIT: $1 TO $1,000,000', heard, fallback: false })
    return dispatch({ type: 'voice_failed', message: "DIDN'T CATCH THAT", heard, fallback: false })
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401) return void unpair()
    if (e instanceof ApiFail && e.code === 'bad_audio') return dispatch({ type: 'voice_failed', message: 'NO SPEECH HEARD', heard: null, fallback: false })
    // Groq down, rate limited, offline: a visible failure with a gesture fallback.
    const wait = e instanceof ApiFail && e.retryAfterMs ? ` · TRY IN ${Math.ceil(e.retryAfterMs / 1000)}s` : ''
    dispatch({ type: 'voice_failed', message: `VOICE UNAVAILABLE${wait}`.slice(0, 32), heard: null, fallback: true })
  }
}

async function run(fx: Effect): Promise<void> {
  switch (fx.type) {
    case 'refresh':
      return void refresh()
    case 'listen_start':
      return void startListening()
    case 'listen_stop':
      return void stopListeningAndTranscribe()
    case 'set_limit': {
      if (!token) return dispatch({ type: 'action_failed', text: 'NOT PAIRED', at: Date.now() })
      try {
        const r = await api.setLimit(token, fx.amount)
        return dispatch({ type: 'confirmed', text: `LIMIT ${formatUsdWhole(r.limit)}`, at: Date.now() })
      } catch (e) {
        if (e instanceof ApiFail && e.status === 401) return void unpair()
        return dispatch({ type: 'action_failed', text: failText(e), at: Date.now() })
      }
    }
    case 'propose':
    case 'confirm':
      return runAction(fx)
  }
}

async function runAction(fx: Extract<Effect, { type: 'propose' | 'confirm' }>): Promise<void> {
  if (!token) return dispatch({ type: 'action_failed', text: 'NOT PAIRED', at: Date.now() })
  try {
    if (fx.type === 'propose') {
      const r = await api.propose(token, fx.kind)
      if (fx.kind === 'dismiss') return dispatch({ type: 'dismissed', at: Date.now() })
      const now = Date.now()
      const proposal: Proposal = {
        proposalId: r.proposalId, kind: r.kind, orders: r.orders, shownAt: now, expiresAt: now + r.expiresInSeconds * 1000,
      }
      return dispatch({ type: 'proposal', proposal })
    }
    const r = await api.confirm(token, fx.proposalId, fx.kind)
    dispatch({ type: 'confirmed', text: confirmText(r), at: Date.now() })
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401) return void unpair()
    // A confirm that got no answer may or may not have executed: never auto-retry it.
    if (fx.type === 'confirm' && e instanceof ApiFail && e.network) {
      dispatch({ type: 'action_failed', text: 'UNSURE · CHECK', at: Date.now() })
      return void refresh()
    }
    dispatch({ type: 'action_failed', text: failText(e), at: Date.now() })
  }
}

async function refresh(): Promise<void> {
  if (!token || refreshing || !foreground) return
  refreshing = true
  try {
    const snapshot = await api.positions(token)
    dispatch({ type: 'snapshot', snapshot, at: Date.now() })
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401) return void unpair()
    const prices = e instanceof ApiFail && (e.code === 'prices_stale' || e.code === 'prices_unavailable')
    dispatch({ type: 'snapshot_failed', problem: prices ? 'prices' : e instanceof ApiFail && e.network ? 'offline' : 'server', at: Date.now() })
  } finally {
    refreshing = false
  }
}

async function unpair(): Promise<void> {
  token = null
  try {
    await bridge.setLocalStorage(TOKEN_STORAGE_KEY, '')
  } catch { /* ignore */ }
  dispatch({ type: 'unpaired' })
  void startPairing()
}

let pairingLoop = 0
async function startPairing(): Promise<void> {
  const myLoop = ++pairingLoop
  for (;;) {
    try {
      const r = await api.pairStart()
      pairingToken = r.token
      dispatch({ type: 'pairing_code', code: r.code, expiresAt: Date.now() + r.expiresInSeconds * 1000 })
      for (;;) {
        await sleep(PAIR_POLL_MS)
        if (myLoop !== pairingLoop) return
        const p = await api.pairPoll(pairingToken)
        if (p.status === 'paired') {
          token = pairingToken
          try {
            await bridge.setLocalStorage(TOKEN_STORAGE_KEY, token)
          } catch { /* the session still works until the app closes */ }
          dispatch({ type: 'paired' })
          return
        }
        if (p.status !== 'pending') break // expired or unknown: get a fresh code
      }
    } catch {
      dispatch({ type: 'pairing_code', code: '', expiresAt: 0 })
      await sleep(5000)
      if (myLoop !== pairingLoop) return
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// -------------------------------------------------------------------- input

// CLICK_EVENT is 0 and protobuf omits zero values, so a tap arrives with eventType undefined.
// The default is resolved INSIDE each envelope so events without that envelope are not taps.
const typeOf = (env?: { eventType?: OsEventTypeList }): OsEventTypeList | null => (env ? (env.eventType ?? OsEventTypeList.CLICK_EVENT) : null)

bridge.onEvenHubEvent((event) => {
  if (event.audioEvent) {
    if (listening) pcmChunks.push(event.audioEvent.audioPcm)
    return
  }
  const types = [typeOf(event.sysEvent), typeOf(event.textEvent), typeOf(event.listEvent)]
  const has = (t: OsEventTypeList) => types.includes(t)
  const at = Date.now()

  if (has(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    // Platform convention: double press leaves the app. Let the user decide on the glasses.
    void bridge.shutDownPageContainer(1)
    return
  }
  if (has(OsEventTypeList.FOREGROUND_EXIT_EVENT)) {
    foreground = false
    if (listening) {
      listening = false
      void bridge.audioControl(false)
    }
  }
  if (has(OsEventTypeList.FOREGROUND_ENTER_EVENT)) {
    foreground = true
    void refresh()
  }
  if (has(OsEventTypeList.SCROLL_TOP_EVENT)) return dispatch({ type: 'swipe', dir: 'up', at })
  if (has(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return dispatch({ type: 'swipe', dir: 'down', at })
  if (has(OsEventTypeList.CLICK_EVENT)) return dispatch({ type: 'press', at })
})

// -------------------------------------------------------------------- boot

const fixtureSnapshot = () => ({
  lastOkAt: Date.now(),
  snapshot: { asOf: '', state: 'NO_LIMIT' as const, limit: null, used: null, left: null, fraction: null, killSwitch: false, cooldown: { active: false, retryAfterMs: 0 }, positions: [] },
})

// Development aid only (stripped from production builds): `?preview=offline|prices|loading` renders
// that screen through the real renderer without touching the backend, to capture non-live screens.
const preview = import.meta.env.DEV ? new URLSearchParams(location.search).get('preview') : null

if (preview) {
  const fixtures: Record<string, () => void> = {
    loading: () => {},
    offline: () => {
      state = { ...initialState(), phase: 'ready', problem: { kind: 'offline', since: 0 } }
    },
    prices: () => {
      state = { ...initialState(), phase: 'ready', problem: { kind: 'prices', since: 0 } }
    },
    // voice screens, rendered without a microphone or backend (a number-free snapshot lets them show)
    stepper: () => {
      state = { ...initialState(), phase: 'ready', ...fixtureSnapshot(), voice: { phase: 'stepper', index: 2 } }
    },
    voice_confirm: () => {
      const now = Date.now()
      state = { ...initialState(), phase: 'ready', ...fixtureSnapshot(), voice: { phase: 'confirm', amount: 500, heard: 'Set limit 500.', shownAt: now, expiresAt: now + 19_500 } }
    },
    voice_unavailable: () => {
      state = { ...initialState(), phase: 'ready', ...fixtureSnapshot(), voice: { phase: 'failed', message: 'VOICE UNAVAILABLE', heard: null, fallback: true } }
    },
    // stress the renderer: switches between very different screens every 2.5 s
    cycle: () => {
      const seq = [
        () => ({ ...initialState(), phase: 'ready' as const, problem: { kind: 'offline' as const, since: 0 } }),
        () => ({ ...initialState(), phase: 'ready' as const, problem: { kind: 'prices' as const, since: 0 } }),
        () => ({ ...initialState(), phase: 'boot' as const }),
        () => ({ ...initialState(), phase: 'pairing' as const, pairing: { code: '123456', expiresAt: Date.now() + 600_000 } }),
        () => ({ ...initialState(), phase: 'ready' as const, voice: { phase: 'thinking' as const } }),
      ]
      let i = 0
      state = seq[0]!()
      setInterval(() => {
        i = (i + 1) % seq.length
        state = seq[i]!()
      }, 2500)
    },
  }
  fixtures[preview]?.()
  await renderer.init(toFrame(buildScreen(state, Date.now()), Date.now()))
  setInterval(paint, FRAME_MS)
} else if (!CONFIGURED) {
  const frame = { status: 'PAPER', big: 'NOT CONFIGURED', gauge: '', sub: 'This build has no backend address.', hint: '' }
  await renderer.init(frame)
} else {
  await renderer.init(toFrame(buildScreen(state, Date.now()), Date.now()))
  try {
    token = (await bridge.getLocalStorage(TOKEN_STORAGE_KEY)) || null
  } catch {
    token = null
  }
  if (token) {
    dispatch({ type: 'paired' })
  } else {
    void startPairing()
  }

  setInterval(() => void refresh(), REFRESH_MS)
  setInterval(() => dispatch({ type: 'tick', at: Date.now() }), 500)
  setInterval(() => foreground && paint(), FRAME_MS)
}

const note = document.getElementById('app')
if (note) note.textContent = 'Haltline is running. Check the glasses display.'
