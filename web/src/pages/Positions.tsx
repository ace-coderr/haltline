import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Gate } from '../components/Gate.tsx'
import { Empty, Notice, PageHead, PaperBadge, Reveal, Spinner, Stat } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import type { PaperView } from '../lib/api.ts'
import { ago, newClientId, parseAmount, price, qty, signed, usd } from '../lib/format.ts'
import { usePoll } from '../lib/hooks.ts'

type Account = PaperView

function Summary({ v, updatedAt, failed }: { v: Account; updatedAt: number | null; failed: boolean }) {
  return (
    <section className="card">
      <div className="live-top">
        <h2>Paper account</h2>
        <PaperBadge />
      </div>
      <div className="stats">
        <Stat label="Balance" value={usd(v.balance)} hint="cash after realised PnL and fees" />
        <Stat label="Equity" value={usd(v.equity)} hint="balance + unrealised" />
        <Stat label="Unrealised" value={signed(v.unrealisedPnl)} tone={v.unrealisedPnl < 0 ? 'bad' : v.unrealisedPnl > 0 ? 'good' : undefined} hint="at live mid prices" />
        <Stat label="Realised today" value={signed(v.realizedToday)} tone={v.realizedToday < 0 ? 'bad' : v.realizedToday > 0 ? 'good' : undefined} hint="net of fees, UTC day" />
      </div>
      <p className="muted small">
        Simulated account. Prices: {v.model.priceSource}. Fills: {v.model.fills} Fee {(v.model.feeRate * 100).toFixed(2)}% per fill, slippage{' '}
        {v.model.slippageBps} bp, exposure capped at {v.model.maxLeverage}x equity, no liquidation engine.
        {updatedAt ? ` Updated ${ago(Date.now() - updatedAt)}.` : ''}
        {failed ? ' Could not refresh just now; showing the last good reading.' : ''}
      </p>
    </section>
  )
}

function OpenForm({ v, onDone }: { v: Account; onDone: () => void }) {
  const [symbol, setSymbol] = useState('ETHUSD')
  const [side, setSide] = useState<'Buy' | 'Sell'>('Buy')
  const [size, setSize] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const key = useRef(newClientId()) // one idempotency key per deliberate submit, reused if a retry is needed

  const row = v.prices.find((p) => p.symbol === symbol) ?? v.prices[0]
  const n = parseAmount(size)
  const est = useMemo(() => {
    if (!row || n === null) return null
    const fill = side === 'Buy' ? row.ask * (1 + v.model.slippageBps / 10_000) : row.bid * (1 - v.model.slippageBps / 10_000)
    return { fill, notional: fill * n, fee: fill * n * v.model.feeRate }
  }, [row, n, side, v.model])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!row) return
    if (n === null || n <= 0) {
      setMsg({ kind: 'error', text: 'Enter a size.' })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await api.open(row.symbol, side, n, key.current)
      key.current = newClientId()
      setSize('')
      setMsg({ kind: 'ok', text: `${side === 'Buy' ? 'Long' : 'Short'} ${qty(n, row.qtyStep)} ${row.base} opened at the live price.` })
      onDone()
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof Error ? err.message : 'Could not open the position.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <div className="live-top">
        <h2>Open a paper position</h2>
        <PaperBadge />
      </div>
      <p className="muted">Real positions to guard. Filled at the live public price plus the stated spread, slippage and fee.</p>
      <div className="form-grid">
        <div>
          <label className="label" htmlFor="sym">Market</label>
          <select id="sym" className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {v.prices.map((p) => (
              <option key={p.symbol} value={p.symbol}>{p.base}/USD · {price(p.bid)} / {price(p.ask)}</option>
            ))}
          </select>
        </div>
        <fieldset className="seg">
          <legend className="label">Direction</legend>
          <label className={side === 'Buy' ? 'on' : ''}><input type="radio" name="side" checked={side === 'Buy'} onChange={() => setSide('Buy')} /> Long</label>
          <label className={side === 'Sell' ? 'on' : ''}><input type="radio" name="side" checked={side === 'Sell'} onChange={() => setSide('Sell')} /> Short</label>
        </fieldset>
        <div>
          <label className="label" htmlFor="size">Size ({row?.base})</label>
          <input id="size" className="input mono" inputMode="decimal" value={size} onChange={(e) => { setSize(e.target.value); setMsg(null) }} placeholder={row ? `min ${qty(row.minQty, row.qtyStep)}` : ''} />
        </div>
      </div>
      {est && (
        <p className="muted small mono">
          ≈ fills at {price(est.fill)} · notional {usd(est.notional)} · fee {usd(est.fee)}
        </p>
      )}
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Opening…' : `Open ${side === 'Buy' ? 'long' : 'short'}`}</button>
    </form>
  )
}

function PositionRow({ p, step, onDone }: { p: Account['positions'][number]; step: number | undefined; onDone: () => void }) {
  const [size, setSize] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newClientId())

  const close = async () => {
    const n = size.trim() === '' ? undefined : parseAmount(size)
    if (n === null) {
      setError('Enter a valid size, or leave blank to close everything.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.close(p.symbol, n, key.current)
      key.current = newClientId()
      setSize('')
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr>
      <td data-label="Market"><strong>{p.symbol}</strong></td>
      <td data-label="Side"><span className={`chip ${p.side === 'Buy' ? 'state-calm' : 'state-closing'}`}>{p.side === 'Buy' ? 'LONG' : 'SHORT'}</span></td>
      <td data-label="Size" className="mono">{qty(p.size, step)}</td>
      <td data-label="Entry" className="mono">{price(p.entryPrice)}</td>
      <td data-label="Mark" className="mono">{price(p.markPrice)}</td>
      <td data-label="Unrealised" className={`mono ${p.unrealisedPnl < 0 ? 'bad' : 'good'}`}>{signed(p.unrealisedPnl)}</td>
      <td data-label="Close">
        <div className="close-cell">
          <input className="input input-sm mono" aria-label={`Size to close for ${p.symbol}`} inputMode="decimal" placeholder="all" value={size} onChange={(e) => setSize(e.target.value)} />
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void close()}>{busy ? '…' : 'Close'}</button>
        </div>
        {error && <span className="bad small">{error}</span>}
      </td>
    </tr>
  )
}

function Positions({ v, onDone }: { v: Account; onDone: () => void }) {
  return (
    <section className="card">
      <div className="live-top">
        <h2>Open positions</h2>
        <PaperBadge />
      </div>
      {v.positions.length === 0 ? (
        <Empty title="No open positions">Open one above. The glasses guard whatever you hold.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table stack-sm">
            <thead>
              <tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Unrealised</th><th>Close</th></tr>
            </thead>
            <tbody>
              {v.positions.map((p) => (
                <PositionRow key={p.symbol} p={p} step={v.prices.find((x) => x.symbol === p.symbol)?.qtyStep} onDone={onDone} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Prices({ v }: { v: Account }) {
  return (
    <section className="card">
      <h2>Live prices</h2>
      <div className="table-wrap">
        <table className="table stack-sm">
          <thead><tr><th>Market</th><th>Bid</th><th>Ask</th><th>Last</th><th>Age</th></tr></thead>
          <tbody>
            {v.prices.map((p) => (
              <tr key={p.symbol}>
                <td data-label="Market"><strong>{p.base}/USD</strong></td>
                <td data-label="Bid" className="mono">{price(p.bid)}</td>
                <td data-label="Ask" className="mono">{price(p.ask)}</td>
                <td data-label="Last" className="mono">{price(p.last)}</td>
                <td data-label="Age" className="muted">{ago(p.ageMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Public market data from {v.model.priceSource}. Prices older than 15 seconds are never used for fills.</p>
    </section>
  )
}

function Reset({ hasPositions, onDone }: { hasPositions: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reset = async () => {
    if (!window.confirm('Reset the paper account to 10,000 USD? Your fill history is kept, and today\'s losses still count toward the daily limit.')) return
    setBusy(true)
    setError(null)
    try {
      await api.resetAccount()
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card">
      <h2>Reset account</h2>
      <p className="muted">Puts the cash balance back to 10,000 USD. Needs a flat account. Fill history is kept, and today&apos;s realised losses still count toward the daily limit, so a reset cannot hide them.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <button className="btn btn-ghost" disabled={busy || hasPositions} onClick={() => void reset()}>
        {hasPositions ? 'Close all positions first' : busy ? 'Resetting…' : 'Reset paper account'}
      </button>
    </section>
  )
}

function Body() {
  const view = usePoll(api.paper, 4000)
  const v = view.data
  return (
    <div className="wrap stack">
      {view.loading && !v && <Spinner label="Loading your paper account" />}
      {view.error && !v && (
        <Notice kind="error">
          {/stale|unavailable/.test(view.error.message) ? 'Live prices are unavailable right now. Nothing was changed.' : view.error.message}
        </Notice>
      )}
      {v && (
        <>
          <Reveal><Summary v={v} updatedAt={view.updatedAt} failed={view.error !== null} /></Reveal>
          <div className="two-col">
            <Reveal><OpenForm v={v} onDone={view.refresh} /></Reveal>
            <Reveal delay={80}><Prices v={v} /></Reveal>
          </div>
          <Reveal><Positions v={v} onDone={view.refresh} /></Reveal>
          <Reveal><Reset hasPositions={v.positions.length > 0} onDone={view.refresh} /></Reveal>
        </>
      )}
    </div>
  )
}

export default function PositionsPage() {
  return (
    <>
      <PageHead
        title="Positions"
        lead="Your simulated paper account, marked to live public prices. Open and close positions here: they are what the glasses guard."
      />
      <Gate>
        <Body />
      </Gate>
    </>
  )
}
