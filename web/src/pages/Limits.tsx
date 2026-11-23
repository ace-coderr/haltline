import { useState } from 'react'
import type { FormEvent } from 'react'
import { Gate } from '../components/Gate.tsx'
import { Empty, Gauge, Notice, PageHead, Reveal, Spinner, Stat, StateChip } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import type { Snapshot } from '../lib/api.ts'
import { ago, LIMIT_MAX, LIMIT_MIN, parseAmount, signed, usd, usdWhole } from '../lib/format.ts'
import { useCountUp, usePoll } from '../lib/hooks.ts'

const PRESETS = [100, 250, 500, 1000, 2500]

function Live({ snap, updatedAt, failed }: { snap: Snapshot; updatedAt: number | null; failed: boolean }) {
  const left = useCountUp(snap.left)
  return (
    <section className={`card live state-${snap.state.toLowerCase()}`} aria-live="polite">
      <div className="live-top">
        <h2>Today&apos;s distance to your limit</h2>
        <StateChip state={snap.state} />
      </div>
      {snap.state === 'NO_LIMIT' ? (
        <Empty title="No daily limit yet">Set one below. The glasses show how much you can still lose today before you reach it.</Empty>
      ) : (
        <>
          <p className="big mono">{usdWhole(left)}</p>
          <p className="muted">left to lose today{snap.state === 'CLOSING' ? ' · CLOSE' : ''}</p>
          <Gauge fraction={snap.fraction} state={snap.state} />
          <div className="stats">
            <Stat label="Limit" value={usd(snap.limit, 0)} />
            <Stat label="Used" value={usd(snap.used)} tone={snap.state === 'TRIPPED' ? 'bad' : undefined} hint="losses + fees, net of gains" />
            <Stat label="Realised today" value={signed(snap.realizedPnl)} tone={snap.realizedPnl < 0 ? 'bad' : snap.realizedPnl > 0 ? 'good' : undefined} hint="net of fees" />
            <Stat label="Unrealised" value={signed(snap.unrealizedPnl)} tone={snap.unrealizedPnl < 0 ? 'bad' : snap.unrealizedPnl > 0 ? 'good' : undefined} hint="at live prices" />
          </div>
        </>
      )}
      <p className="muted small">
        Paper account · UTC day · {updatedAt ? `updated ${ago(Date.now() - updatedAt)}` : ''}
        {failed ? ' · could not refresh just now, showing the last good reading' : ''}
        {snap.cooldown.active ? ` · action cooldown: ${Math.ceil(snap.cooldown.retryAfterMs / 1000)}s` : ''}
      </p>
    </section>
  )
}

function LimitForm({ current, onSaved }: { current: number | null; onSaved: () => void }) {
  const [text, setText] = useState(current !== null ? String(current) : '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const n = parseAmount(text)
    if (n === null || n < LIMIT_MIN || n > LIMIT_MAX) {
      setMsg({ kind: 'error', text: `Enter an amount between $${LIMIT_MIN} and $${LIMIT_MAX.toLocaleString('en-US')}.` })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.setLimit(n)
      setText(String(r.limit))
      setMsg({ kind: 'ok', text: `Daily limit set to ${usd(r.limit)}.` })
      onSaved()
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save the limit.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={save} noValidate>
      <h2>Daily loss limit</h2>
      <p className="muted">The most you are willing to lose in one UTC day on this paper account. Fees count. The glasses count down to it.</p>
      <label htmlFor="limit" className="label">Limit in USD</label>
      <div className="input-row">
        <span className="prefix mono">$</span>
        <input id="limit" className="input mono" inputMode="decimal" value={text} onChange={(e) => { setText(e.target.value); setMsg(null) }} placeholder="500" />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save limit'}</button>
      </div>
      <div className="chips" aria-label="Quick values">
        {PRESETS.map((p) => (
          <button type="button" key={p} className="chip chip-btn" onClick={() => { setText(String(p)); setMsg(null) }}>${p.toLocaleString('en-US')}</button>
        ))}
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <p className="muted small">Raising the limit from the glasses is refused while you are close to it or past it. From here it is always allowed.</p>
    </form>
  )
}

function KillSwitch({ on, onChanged }: { on: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.setKillSwitch(!on)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the kill switch.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={`card kill ${on ? 'on' : ''}`}>
      <div className="live-top">
        <h2>Kill switch</h2>
        <span className={`chip ${on ? 'state-tripped' : 'state-calm'}`}>{on ? 'WRITES OFF' : 'WRITES ON'}</span>
      </div>
      <p className="muted">
        When on, every action from the glasses (cut half, cut all) is refused by the server. Reading and the limit keep working. Only this
        page can switch it, so the glasses cannot turn it back on.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      <button className={`btn ${on ? 'btn-primary' : 'btn-danger'}`} disabled={busy} onClick={() => void toggle()} aria-pressed={on}>
        {busy ? 'Working…' : on ? 'Turn writes back on' : 'Switch all writes off'}
      </button>
    </section>
  )
}

function LimitsBody() {
  const snap = usePoll(api.snapshot, 4000)
  const known = snap.data
  return (
    <div className="wrap stack">
      {snap.loading && !known && <Spinner label="Reading your paper account" />}
      {snap.error && !known && (
        <Notice kind="error">
          {snap.error instanceof ApiError && (snap.error.code === 'prices_stale' || snap.error.code === 'prices_unavailable')
            ? 'Live prices are unavailable right now, so Haltline will not show a number. Nothing was changed.'
            : snap.error.message}
        </Notice>
      )}
      {known && (
        <Reveal>
          <Live snap={known} updatedAt={snap.updatedAt} failed={snap.error !== null} />
        </Reveal>
      )}
      {(known || snap.error) && (
        <div className="two-col">
          <Reveal>
            <LimitForm key={known?.limit ?? 'none'} current={known?.limit ?? null} onSaved={snap.refresh} />
          </Reveal>
          <Reveal delay={80}>
            <KillSwitch on={known?.killSwitch ?? false} onChanged={snap.refresh} />
          </Reveal>
        </div>
      )}
    </div>
  )
}

export default function Limits() {
  return (
    <>
      <PageHead title="Limits" lead="Your daily loss limit, live. This is the number the glasses count down." />
      <Gate>
        <LimitsBody />
      </Gate>
    </>
  )
}
