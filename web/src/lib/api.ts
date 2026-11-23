// Client for the Haltline Edge Functions. The browser only ever holds the user's own
// Supabase session; the backend decides what that session may do.
import { CONFIGURED, SUPABASE_ANON_KEY, SUPABASE_URL } from './env.ts'
import { supabase } from './supabase.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterMs: number | null
  readonly network: boolean
  constructor(status: number, code: string, message: string, retryAfterMs: number | null = null, network = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
    this.network = network
  }
}

export async function callFn<T>(name: string, opts: { method?: 'GET' | 'POST'; body?: unknown; auth?: boolean } = {}): Promise<T> {
  if (!CONFIGURED) throw new ApiError(0, 'not_configured', 'This build has no backend address.')
  const headers: Record<string, string> = { apikey: SUPABASE_ANON_KEY }
  if (opts.auth !== false) {
    const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } }
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the Haltline backend. Check your connection.', null, true)
  }
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    /* not JSON */
  }
  if (!res.ok || !json || json.ok === false) {
    const err = (json?.error ?? {}) as { code?: string; message?: string; retryAfterMs?: number }
    throw new ApiError(res.status, err.code ?? 'bad_response', err.message ?? `Request failed (HTTP ${res.status}).`, typeof err.retryAfterMs === 'number' ? err.retryAfterMs : null)
  }
  return json as T
}

// ----------------------------------------------------------------------- response types

export type RiskState = 'CALM' | 'CLOSING' | 'TRIPPED' | 'NO_LIMIT'

export interface Snapshot {
  mode: 'PAPER'
  asOf: string
  state: RiskState
  limit: number | null
  used: number | null
  left: number | null
  fraction: number | null
  realizedPnl: number
  unrealizedPnl: number
  killSwitch: boolean
  cooldown: { active: boolean; retryAfterMs: number }
  positions: { symbol: string; side: 'Buy' | 'Sell'; size: number; unrealisedPnl: number }[]
}

export interface PriceRow {
  symbol: string
  base: string
  bid: number
  ask: number
  last: number
  ageMs: number
  qtyStep?: number
  minQty?: number
}

export interface PaperView {
  mode: 'PAPER'
  balance: number
  startingBalance: number
  unrealisedPnl: number
  equity: number
  realizedToday: number
  positions: { symbol: string; side: 'Buy' | 'Sell'; size: number; entryPrice: number; markPrice: number; unrealisedPnl: number }[]
  fills: { id: string; symbol: string; side: 'Buy' | 'Sell'; qty: number; price: number; fee: number; realizedPnl: number; reduceOnly: boolean; source: 'manual' | 'guard'; at: string }[]
  prices: Required<PriceRow>[]
  model: { feeRate: number; slippageBps: number; maxLeverage: number; startingBalance: number; priceSource: string; fills: string; quoteCurrency: string }
}

export interface Health {
  mode: 'PAPER'
  ok: boolean
  time: string
  region: string | null
  db: 'ok' | 'error'
  priceSource: { name: string; status: string; ageMs: number | null }
  voice: 'configured' | 'not_configured'
}

export const api = {
  health: () => callFn<Health>('health', { auth: false }),
  snapshot: () => callFn<Snapshot>('positions'),
  paper: () => callFn<PaperView>('paper'),
  prices: () => callFn<{ source: string; quotes: PriceRow[] }>('prices', { auth: false }),
  limits: () => callFn<{ limit: number | null; killSwitch: boolean }>('limits'),
  setLimit: (limit: number) => callFn<{ limit: number }>('limits', { body: { limit } }),
  setKillSwitch: (killSwitch: boolean) => callFn<{ killSwitch: boolean }>('limits', { body: { killSwitch } }),
  open: (symbol: string, side: 'Buy' | 'Sell', size: number, clientId: string) =>
    callFn<{ fillId: string; duplicate: boolean; balance: number }>('paper', { body: { action: 'open', symbol, side, size, clientId } }),
  close: (symbol: string, size: number | undefined, clientId: string) =>
    callFn<{ fillId: string; duplicate: boolean; balance: number }>('paper', { body: { action: 'close', symbol, ...(size !== undefined ? { size } : {}), clientId } }),
  resetAccount: () => callFn<{ reset: true }>('paper', { body: { action: 'reset' } }),
  claimPairing: (code: string) => callFn<{ paired: true }>('pair', { body: { action: 'claim', code } }),
  revokeDevice: (deviceId: string) => callFn<{ revoked: true }>('pair', { body: { action: 'revoke', deviceId } }),
}
