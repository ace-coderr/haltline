import { PageHead, PaperBadge, Reveal, Section, Spinner } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { SUPABASE_URL } from '../lib/env.ts'
import { ago } from '../lib/format.ts'
import { usePoll } from '../lib/hooks.ts'

function HealthCard() {
  const h = usePoll(api.health, 15000)
  const d = h.data
  return (
    <div className="card health" aria-live="polite">
      <div className="live-top">
        <h3>Live backend status</h3>
        <PaperBadge />
      </div>
      {h.loading && !d && <Spinner label="Checking" />}
      {h.error && !d && <p className="bad">Could not reach the backend: {h.error.message}</p>}
      {d && (
        <dl className="kv">
          <dt>Overall</dt><dd className={d.ok ? 'good' : 'bad'}>{d.ok ? 'ok' : 'degraded'}</dd>
          <dt>Region</dt><dd className="mono">{d.region ?? 'unknown'}</dd>
          <dt>Database</dt><dd className={d.db === 'ok' ? 'good' : 'bad'}>{d.db}</dd>
          <dt>Price source</dt><dd>{d.priceSource.name}: <span className={d.priceSource.status === 'ok' ? 'good' : 'bad'}>{d.priceSource.status}</span>{d.priceSource.ageMs !== null ? `, newest quote ${ago(d.priceSource.ageMs)}` : ''}</dd>
          <dt>Voice</dt><dd>{d.voice === 'configured' ? 'configured' : 'not configured'}</dd>
          <dt>Server time</dt><dd className="mono">{d.time}</dd>
        </dl>
      )}
    </div>
  )
}

const ENDPOINTS: { name: string; method: string; auth: string; what: string }[] = [
  { name: 'health', method: 'GET', auth: 'none', what: 'Database, price source and voice status. Also keeps the demo awake.' },
  { name: 'prices', method: 'GET', auth: 'none', what: 'Live bid, ask and last for the five markets, with the age of each quote.' },
  { name: 'pair', method: 'POST', auth: 'varies', what: 'action: start (glasses), poll (glasses token), claim (website session), revoke (website session).' },
  { name: 'limits', method: 'GET, POST', auth: 'token or session', what: 'Read or set the daily limit. Kill switch changes need a website session.' },
  { name: 'positions', method: 'GET', auth: 'token or session', what: 'The snapshot the glasses show: state, left, used, gauge fraction, positions, cooldown.' },
  { name: 'act', method: 'POST', auth: 'token or session', what: 'action: propose (cut_half, cut_all, dismiss) then confirm with the proposalId.' },
  { name: 'paper', method: 'GET, POST', auth: 'token (read) or session', what: 'The paper account: view, open, close, reset. Writes need a website session.' },
  { name: 'transcribe', method: 'POST', auth: 'token or session', what: 'WAV audio in; transcript and parsed command out. Writes nothing.' },
]

const ERRORS: [string, string][] = [
  ['unauthorized (401)', 'No valid website session or device token.'],
  ['cooldown (429)', 'An action was executed less than 60 seconds ago. retryAfterMs says how long.'],
  ['kill_switch (403)', 'Writes are switched off on the Limits page.'],
  ['too_soon (425)', 'Confirm arrived too fast after the proposal: treated as a stray press.'],
  ['expired / consumed (410 / 409)', 'The 20-second proposal ran out, or was already confirmed once.'],
  ['raise_blocked (403)', 'Raising the limit from the glasses is blocked while CLOSING IN or TRIPPED.'],
  ['prices_stale / prices_unavailable (503)', 'No fresh public price. Nothing was changed and no number is shown.'],
  ['reduce_only_* / insufficient_margin (409)', 'The paper account refused the order (no position, wrong side, too large, or over 5x equity).'],
  ['rate_limited (429)', 'Too many requests or too many wrong pairing codes.'],
]

export default function Docs() {
  const base = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : 'https://<project>.supabase.co/functions/v1'
  return (
    <>
      <PageHead title="Docs and API" lead="The backend behind the glasses and this site: eight small Supabase Edge Functions. Everything here is the real, deployed API." />

      <Section kicker="Status" title="Live">
        <Reveal><HealthCard /></Reveal>
      </Section>

      <Section kicker="Paper account" title="How fills are priced">
        <div className="two-col">
          <Reveal>
            <div className="card">
              <h3>The model</h3>
              <ul className="ticks">
                <li>One account per person, started at <strong>10,000 USD</strong>. Net long or short positions, no liquidation engine.</li>
                <li>Buys fill at the live <strong>ask</strong>, sells at the live <strong>bid</strong>, each plus <strong>1 bp</strong> adverse slippage.</li>
                <li>Taker fee <strong>0.05%</strong> of notional on every fill. Fees count as realised loss against your limit.</li>
                <li>Positions are marked at the bid/ask mid. Total exposure is capped at <strong>5x equity</strong>.</li>
                <li>Prices come from Bitstamp&apos;s public ticker (no API key). A quote older than <strong>15 seconds</strong> is never used.</li>
              </ul>
            </div>
          </Reveal>
          <Reveal delay={80}>
            <div className="card">
              <h3>Why paper</h3>
              <p className="muted">
                Exchange testnet sign-ups are not available in every region, so Haltline simulates the account itself and prices it from real
                public data. The exchange sits behind a small adapter interface, so a real testnet adapter could replace it without touching
                the limit maths, the confirm flow, the cooldown or the kill switch.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section kicker="Reference" title="Endpoints">
        <Reveal>
          <div className="card">
            <p className="muted small">Base URL: <code className="mono">{base}</code>. Send the public project key as the <code className="mono">apikey</code> header.</p>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Endpoints table, scrollable">
              <table className="table">
                <thead><tr><th>Function</th><th>Method</th><th>Auth</th><th>What it does</th></tr></thead>
                <tbody>
                  {ENDPOINTS.map((e) => (
                    <tr key={e.name}>
                      <td><code className="mono">{e.name}</code></td><td className="mono">{e.method}</td><td>{e.auth}</td><td className="muted">{e.what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Reveal>
      </Section>

      <Section kicker="Authentication" title="Two ways in">
        <div className="two-col">
          <Reveal>
            <div className="card">
              <h3>Website session</h3>
              <p className="muted">A Supabase session JWT in <code className="mono">Authorization: Bearer</code>. Can do everything, including the kill switch, removing devices and paper trades.</p>
            </div>
          </Reveal>
          <Reveal delay={80}>
            <div className="card">
              <h3>Glasses device token</h3>
              <p className="muted">Obtained by pairing, sent as <code className="mono">x-device-token</code>. Can read, propose and confirm cuts and set the limit (with the raise rule). It cannot touch the kill switch or place paper trades.</p>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section kicker="Examples" title="Try it">
        <Reveal>
          <div className="card code-card">
            <p className="muted small">Public price feed (no sign-in):</p>
            <pre className="code" tabIndex={0} aria-label="Code example"><code>{`curl "${base}/prices" -H "apikey: $HALTLINE_PUBLIC_KEY"`}</code></pre>
            <p className="muted small">A cut, as the glasses do it (two steps):</p>
            <pre className="code" tabIndex={0} aria-label="Code example"><code>{`curl -X POST "${base}/act" -H "apikey: $HALTLINE_PUBLIC_KEY" \\
  -H "x-device-token: $DEVICE_TOKEN" -H "Content-Type: application/json" \\
  -d '{"action":"propose","kind":"cut_half"}'
# wait at least a second, then within 20 s:
curl -X POST "${base}/act" ... -d '{"action":"confirm","proposalId":"<id>","kind":"cut_half"}'`}</code></pre>
            <p className="muted small">Every JSON response carries <code className="mono">"mode": "PAPER"</code>.</p>
          </div>
        </Reveal>
      </Section>

      <Section kicker="Voice" title="What you can say">
        <Reveal>
          <div className="card">
            <p className="muted">Say a daily limit, for example: <q>set limit five hundred</q>, <q>set the limit to twelve hundred dollars</q>, <q>set limit 2.5k</q>. Amounts from $1 to $1,000,000 are accepted. Relative phrases such as <q>raise it by a hundred</q> are deliberately not understood. The transcript only proposes a limit: you confirm with a press before anything is saved.</p>
          </div>
        </Reveal>
      </Section>

      <Section kicker="Errors" title="What you may see">
        <Reveal>
          <div className="card">
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Error codes table, scrollable">
              <table className="table">
                <thead><tr><th>Code</th><th>Meaning</th></tr></thead>
                <tbody>
                  {ERRORS.map(([c, m]) => <tr key={c}><td><code className="mono">{c}</code></td><td className="muted">{m}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        </Reveal>
      </Section>
    </>
  )
}
