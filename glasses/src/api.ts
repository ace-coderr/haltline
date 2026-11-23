// Client for the Haltline backend. The glasses talk ONLY to these Supabase Edge Functions,
// authenticated with a device token obtained by pairing. No exchange or API keys here.

import type { ActionKind, Snapshot } from './model.ts'

export class ApiFail extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterMs: number | null
  /** True when no HTTP response was received at all (offline, timeout, DNS). */
  readonly network: boolean
  constructor(status: number, code: string, message: string, retryAfterMs: number | null = null, network = false) {
    super(message)
    this.name = 'ApiFail'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
    this.network = network
  }
}

export interface ApiConfig {
  baseUrl: string
  anonKey: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export interface ProposalReply {
  proposalId: string
  kind: 'cut_half' | 'cut_all'
  expiresInSeconds: number
  orders: { symbol: string; side: 'Buy' | 'Sell'; qty: string }[]
}

export interface ConfirmReply {
  executed: number
  failed: number
  results: { symbol: string; qty: string; status: 'executed' | 'failed'; reason?: string }[]
}

export type PairStatus = 'pending' | 'paired' | 'expired' | 'unknown'

export function createApi(cfg: ApiConfig) {
  const doFetch = cfg.fetchFn ?? fetch.bind(globalThis)
  const timeoutMs = cfg.timeoutMs ?? 8000

  async function call<T>(
    fn: string,
    opts: { method?: 'GET' | 'POST'; body?: unknown; token?: string | null; raw?: { body: Uint8Array; contentType: string } } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { apikey: cfg.anonKey }
    if (opts.token) headers['x-device-token'] = opts.token
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.raw) headers['Content-Type'] = opts.raw.contentType
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    let res: Response
    try {
      res = await doFetch(`${cfg.baseUrl}/functions/v1/${fn}`, {
        method: opts.method ?? (opts.body !== undefined || opts.raw ? 'POST' : 'GET'),
        headers,
        body: opts.raw ? (opts.raw.body as BodyInit) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctl.signal,
      })
    } catch {
      throw new ApiFail(0, 'network', 'Could not reach the backend.', null, true)
    } finally {
      clearTimeout(timer)
    }
    let json: Record<string, unknown> | null = null
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      /* not JSON */
    }
    if (!res.ok || !json || json.ok === false) {
      const err = (json?.error ?? {}) as { code?: string; message?: string; retryAfterMs?: number }
      throw new ApiFail(res.status, err.code ?? 'bad_response', err.message ?? `HTTP ${res.status}`, typeof err.retryAfterMs === 'number' ? err.retryAfterMs : null)
    }
    return json as T
  }

  return {
    pairStart: () => call<{ code: string; token: string; expiresInSeconds: number }>('pair', { body: { action: 'start' } }),
    pairPoll: (token: string) => call<{ status: PairStatus }>('pair', { body: { action: 'poll' }, token }),
    positions: (token: string) => call<Snapshot>('positions', { token }),
    setLimit: (token: string, limit: number) => call<{ limit: number }>('limits', { body: { limit }, token }),
    transcribe: (token: string, wav: Uint8Array) =>
      call<{ text: string; command: { kind: 'set_limit'; amount: number } | { kind: 'out_of_range'; amount: number } | { kind: 'unclear' } }>('transcribe', {
        raw: { body: wav, contentType: 'audio/wav' },
        token,
      }),
    propose: (token: string, kind: ActionKind) =>
      call<ProposalReply & { dismissed?: true }>('act', { body: { action: 'propose', kind }, token }),
    confirm: (token: string, proposalId: string, kind: 'cut_half' | 'cut_all') =>
      call<ConfirmReply>('act', { body: { action: 'confirm', proposalId, kind }, token }),
  }
}

export type Api = ReturnType<typeof createApi>

/** Short, glanceable text for a refused or failed action. */
export function failText(e: unknown): string {
  if (!(e instanceof ApiFail)) return 'FAILED'
  if (e.network) return 'OFFLINE'
  switch (e.code) {
    case 'cooldown': return `WAIT ${Math.max(1, Math.ceil((e.retryAfterMs ?? 1000) / 1000))}s`
    case 'kill_switch': return 'WRITES OFF'
    case 'no_positions': return 'NO POSITIONS'
    case 'nothing_to_reduce': return 'TOO SMALL'
    case 'prices_stale':
    case 'prices_unavailable': return 'NO PRICES'
    case 'expired': return 'EXPIRED'
    case 'consumed': return 'ALREADY DONE'
    case 'too_soon': return 'PRESS AGAIN'
    case 'rate_limited': return 'SLOW DOWN'
    case 'raise_blocked': return 'USE THE SITE'
    case 'bad_limit': return 'BAD LIMIT'
    default: return 'FAILED'
  }
}

/** Result text after a confirm reply. */
export function confirmText(r: ConfirmReply): string {
  if (r.executed > 0 && r.failed === 0) return `DONE · ${r.executed} ORDER${r.executed > 1 ? 'S' : ''}`
  if (r.executed > 0) return `PARTIAL ${r.executed}/${r.executed + r.failed}`
  return 'NOT SENT'
}
