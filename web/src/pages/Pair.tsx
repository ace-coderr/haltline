import { useState } from 'react'
import type { FormEvent } from 'react'
import { Gate } from '../components/Gate.tsx'
import { Empty, Notice, PageHead, Reveal, Shot } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { asset } from '../lib/env.ts'
import { ago, cleanCode, isValidCode, timeOf } from '../lib/format.ts'
import { usePoll } from '../lib/hooks.ts'
import { supabase } from '../lib/supabase.ts'

interface DeviceRow {
  id: string
  label: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

async function loadDevices(): Promise<DeviceRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('devices')
    .select('id,label,created_at,last_seen_at,revoked_at')
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error('Could not load your devices.')
  return (data ?? []) as DeviceRow[]
}

function PairForm({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!isValidCode(code)) {
      setError('Enter the 6 digits shown on your glasses.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.claimPairing(code)
      setDone(true)
      setCode('')
      onPaired()
    } catch (err) {
      setDone(false)
      setError(
        err instanceof ApiError && err.code === 'rate_limited'
          ? 'Too many wrong codes. Wait a few minutes before trying again.'
          : err instanceof ApiError && err.code === 'invalid_code'
            ? 'That code is wrong or has expired. Codes last 10 minutes; reopen Haltline on the glasses for a fresh one.'
            : err instanceof Error
              ? err.message
              : 'Pairing failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card pair-form" onSubmit={submit} noValidate>
      <label htmlFor="code" className="label">Code shown on your glasses</label>
      <input
        id="code"
        className="code-input mono"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000 000"
        aria-describedby="code-help"
        value={code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
        onChange={(e) => {
          setCode(cleanCode(e.target.value))
          setError(null)
          setDone(false)
        }}
        maxLength={7}
      />
      <p id="code-help" className="muted small">Six digits, valid for 10 minutes. Open Haltline on your glasses to see one.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {done && <Notice kind="ok">Paired. Your glasses connect within a few seconds and show your numbers.</Notice>}
      <button className="btn btn-primary" disabled={busy || code.length !== 6}>
        {busy ? 'Pairing…' : 'Pair glasses'}
      </button>
    </form>
  )
}

function Devices() {
  const devices = usePoll(loadDevices, 6000)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const remove = async (id: string) => {
    if (!window.confirm('Remove this device? The glasses will show a new pairing code.')) return
    setRemoving(id)
    setError(null)
    try {
      await api.revokeDevice(id)
      devices.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the device.')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <section className="card">
      <h2>Your paired devices</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {devices.error && !devices.data && <Notice kind="error">{devices.error.message}</Notice>}
      {devices.data && devices.data.length === 0 && <Empty title="No devices paired yet">Pair your glasses with the code above.</Empty>}
      {devices.data && devices.data.length > 0 && (
        <ul className="rows">
          {devices.data.map((d) => (
            <li key={d.id} className="row">
              <div>
                <strong>{d.label}</strong>
                <div className="muted small">
                  Paired {timeOf(d.created_at)} ·{' '}
                  {d.last_seen_at ? `last seen ${ago(Date.now() - Date.parse(d.last_seen_at))}` : 'not seen yet'}
                </div>
              </div>
              <button className="btn btn-sm btn-ghost" disabled={removing === d.id} onClick={() => void remove(d.id)}>
                {removing === d.id ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function Pair() {
  const [tick, setTick] = useState(0)
  return (
    <>
      <PageHead
        title="Pair a device"
        lead="Link your Even G2 glasses to your paper account. The glasses show a code; you enter it here. No password, no email."
      />
      <div className="wrap two-col">
        <Reveal>
          <Gate>
            <PairForm onPaired={() => setTick((t) => t + 1)} />
            <div key={tick}>
              <Devices />
            </div>
          </Gate>
        </Reveal>
        <Reveal delay={80}>
          <Shot base={asset('')} file="glasses-pairing.png" alt="Glasses screen showing a six-digit pairing code" caption="What your glasses show before they are paired (official simulator capture)." />
          <ol className="steps-list">
            <li>Open Haltline on your glasses.</li>
            <li>Read the 6-digit code on the display.</li>
            <li>Enter it here and press Pair glasses.</li>
          </ol>
        </Reveal>
      </div>
    </>
  )
}
