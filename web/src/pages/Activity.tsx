import { useState } from 'react'
import { Gate } from '../components/Gate.tsx'
import { Empty, Notice, PageHead, PaperBadge, Reveal, Spinner } from '../components/ui.tsx'
import { price, qty, signed, timeOf, usd } from '../lib/format.ts'
import { usePoll } from '../lib/hooks.ts'
import { supabase } from '../lib/supabase.ts'

interface ActionRow {
  id: string
  kind: 'cut_half' | 'cut_all' | 'dismiss' | 'set_limit' | 'kill_switch'
  status: 'executed' | 'failed' | 'rejected'
  reason: string | null
  symbol: string | null
  side: 'Buy' | 'Sell' | null
  size: number | null
  detail: Record<string, unknown>
  created_at: string
}

interface FillRow {
  id: string
  symbol: string
  side: 'Buy' | 'Sell'
  qty: number
  price: number
  fee: number
  realized_pnl: number
  reduce_only: boolean
  source: 'manual' | 'guard'
  created_at: string
}

async function loadActivity(): Promise<{ actions: ActionRow[]; fills: FillRow[] }> {
  if (!supabase) return { actions: [], fills: [] }
  const [a, f] = await Promise.all([
    supabase.from('actions_log').select('id,kind,status,reason,symbol,side,size,detail,created_at').order('created_at', { ascending: false }).limit(100),
    supabase.from('paper_fills').select('id,symbol,side,qty,price,fee,realized_pnl,reduce_only,source,created_at').order('created_at', { ascending: false }).limit(100),
  ])
  if (a.error || f.error) throw new Error('Could not load your activity.')
  return {
    actions: (a.data ?? []) as ActionRow[],
    fills: ((f.data ?? []) as FillRow[]).map((r) => ({ ...r, qty: Number(r.qty), price: Number(r.price), fee: Number(r.fee), realized_pnl: Number(r.realized_pnl) })),
  }
}

const KIND: Record<ActionRow['kind'], string> = {
  cut_half: 'Cut half',
  cut_all: 'Cut all',
  dismiss: 'Dismissed',
  set_limit: 'Limit change',
  kill_switch: 'Kill switch',
}

const REASON: Record<string, string> = {
  too_soon: 'confirmed too fast (stray press guard)',
  consumed: 'already confirmed once',
  expired: 'the 20 s confirmation expired',
  cooldown: 'cooldown active',
  kill_switch: 'kill switch is on',
  raise_blocked: 'raising the limit from the glasses is blocked near the limit',
  missing: 'no such pending action',
  kind_mismatch: 'did not match the pending action',
}

function detail(r: ActionRow): string {
  if (r.kind === 'set_limit') {
    const d = r.detail as { from?: number | null; to?: number; via?: string }
    const to = typeof d.to === 'number' ? usd(d.to, 0) : '?'
    const from = typeof d.from === 'number' ? usd(d.from, 0) : 'none'
    return `${from} → ${to}${d.via ? ` (via ${d.via === 'device' ? 'glasses' : 'website'})` : ''}`
  }
  if (r.kind === 'kill_switch') return (r.detail as { on?: boolean }).on ? 'writes switched off' : 'writes switched on'
  if (r.symbol) return `${r.side === 'Buy' ? 'BUY' : 'SELL'} ${r.size ?? ''} ${r.symbol}`
  return ''
}

type Filter = 'all' | 'executed' | 'refused'

function Body() {
  const act = usePoll(loadActivity, 6000)
  const [filter, setFilter] = useState<Filter>('all')
  const d = act.data
  const actions = (d?.actions ?? []).filter((r) => (filter === 'all' ? true : filter === 'executed' ? r.status === 'executed' : r.status !== 'executed'))

  return (
    <div className="wrap stack">
      {act.loading && !d && <Spinner label="Loading activity" />}
      {act.error && !d && <Notice kind="error">{act.error.message}</Notice>}
      {d && (
        <>
          <Reveal>
            <section className="card">
              <div className="live-top">
                <h2>Actions log</h2>
                <PaperBadge />
              </div>
              <p className="muted">Every guard action, refusal and settings change, with its timestamp, size and result. Written by the server, read-only here.</p>
              <div className="chips" role="group" aria-label="Filter actions">
                {(['all', 'executed', 'refused'] as const).map((f) => (
                  <button key={f} className={`chip chip-btn ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                    {f === 'all' ? 'All' : f === 'executed' ? 'Executed' : 'Refused or failed'}
                  </button>
                ))}
              </div>
              {actions.length === 0 ? (
                <Empty title="Nothing here yet">Actions appear when you confirm a cut on the glasses, change the limit or use the kill switch.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table stack-sm">
                    <thead><tr><th>Time</th><th>Action</th><th>Result</th><th>Details</th></tr></thead>
                    <tbody>
                      {actions.map((r) => (
                        <tr key={r.id}>
                          <td data-label="Time" className="muted nowrap">{timeOf(r.created_at)}</td>
                          <td data-label="Action"><strong>{KIND[r.kind]}</strong></td>
                          <td data-label="Result">
                            <span className={`chip ${r.status === 'executed' ? 'state-calm' : r.status === 'failed' ? 'state-tripped' : 'state-closing'}`}>{r.status}</span>
                            {r.reason && <span className="muted small"> {REASON[r.reason] ?? r.reason}</span>}
                          </td>
                          <td data-label="Details" className="mono">{detail(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </Reveal>
          <Reveal>
            <section className="card">
              <div className="live-top">
                <h2>Paper fills</h2>
                <PaperBadge />
              </div>
              <p className="muted">Every simulated fill: yours from the Positions page and the guard&apos;s reduce-only cuts.</p>
              {d.fills.length === 0 ? (
                <Empty title="No fills yet">Open a paper position on the Positions page.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table stack-sm">
                    <thead><tr><th>Time</th><th>Source</th><th>Fill</th><th>Price</th><th>Fee</th><th>Realised</th></tr></thead>
                    <tbody>
                      {d.fills.map((f) => (
                        <tr key={f.id}>
                          <td data-label="Time" className="muted nowrap">{timeOf(f.created_at)}</td>
                          <td data-label="Source"><span className={`chip ${f.source === 'guard' ? 'state-closing' : ''}`}>{f.source === 'guard' ? 'guard' : 'you'}</span></td>
                          <td data-label="Fill" className="mono">{f.side === 'Buy' ? 'BUY' : 'SELL'} {qty(f.qty, 0.0001)} {f.symbol}{f.reduce_only ? ' · reduce-only' : ''}</td>
                          <td data-label="Price" className="mono">{price(f.price)}</td>
                          <td data-label="Fee" className="mono">{usd(f.fee, 4)}</td>
                          <td data-label="Realised" className={`mono ${f.realized_pnl < 0 ? 'bad' : f.realized_pnl > 0 ? 'good' : ''}`}>{f.realized_pnl === 0 ? '--' : signed(f.realized_pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </Reveal>
        </>
      )}
    </div>
  )
}

export default function Activity() {
  return (
    <>
      <PageHead title="Activity" lead="Everything the guard did, and everything you did to the paper account, in order." />
      <Gate>
        <Body />
      </Gate>
    </>
  )
}
