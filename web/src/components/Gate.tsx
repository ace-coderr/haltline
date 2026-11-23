import { useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../lib/auth.tsx'
import { Notice, Spinner } from './ui.tsx'

/**
 * Shows its children only with a paper account. Accounts are created on request (never
 * automatically), so visiting the site does not create anything.
 */
export function Gate({ children }: { children: ReactNode }) {
  const { status, startAccount } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status === 'loading') return <div className="wrap"><Spinner /></div>
  if (status === 'unconfigured') {
    return (
      <div className="wrap">
        <Notice kind="error">This build of the site has no backend address, so live data is unavailable.</Notice>
      </div>
    )
  }
  if (status === 'signed_in') return <>{children}</>

  return (
    <div className="wrap">
      <div className="card gate">
        <h2>Start a paper account</h2>
        <p>
          Haltline keeps a simulated trading account for you: 10,000 USD of paper money, priced from live public market data. It lives
          in this browser, with no email or password.
        </p>
        <ul className="ticks">
          <li>No real funds, ever. Nothing here reaches a real exchange.</li>
          <li>Clearing this site&apos;s data in your browser removes access to the account.</li>
        </ul>
        {error && <Notice kind="error">{error}</Notice>}
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(await startAccount())
            setBusy(false)
          }}
        >
          {busy ? 'Creating…' : 'Create my paper account'}
        </button>
      </div>
    </div>
  )
}
