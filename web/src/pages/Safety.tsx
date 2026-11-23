import { Link } from 'react-router-dom'
import { PageHead, Reveal, Section } from '../components/ui.tsx'

const RULES: { t: string; b: string }[] = [
  {
    t: 'Paper only, enforced in code',
    b: 'There is no real exchange integration. Every outbound request must match an exact allowlist: the public Bitstamp price ticker (GET) and the speech-to-text endpoint (POST). A test scans the backend source and fails if any file names a real exchange\'s trading or payout surface, contains an unlisted host, or makes network calls outside the two approved modules.',
  },
  {
    t: 'Reduce-only cuts',
    b: 'A guard cut is applied to the paper account as a reduce-only order, in one database transaction. It can close or shrink a position. It is refused if there is no position, if it is on the wrong side, or if it is larger than the position. It can never open, grow or flip one.',
  },
  {
    t: 'Confirm, stray-press guard, cooldown',
    b: 'A cut is two steps. Proposing creates a 20-second, single-use proposal; confirming consumes it exactly once, so a double press cannot send two orders. A confirm that arrives within the first moments is refused as a stray press. After an executed cut, one more action is allowed only after 60 seconds, enforced atomically in the database so two simultaneous requests cannot both pass.',
  },
  {
    t: 'Kill switch',
    b: 'One switch on the Limits page makes the server refuse every cut. It can only be changed from the website: the glasses cannot turn writes back on.',
  },
  {
    t: 'The limit cannot be raised in a panic',
    b: 'From the glasses, raising the daily limit is refused while you are CLOSING IN, TRIPPED, or when the state cannot be determined. Lowering is always allowed. From the website you decide.',
  },
  {
    t: 'Fails closed on bad data',
    b: 'Prices older than 15 seconds are never used for fills or marks. If prices are stale or the connection drops, the glasses replace the number with NO PRICES or OFFLINE and block actions. A confirm that gets no answer is never retried automatically: the glasses say UNSURE and refresh instead.',
  },
  {
    t: 'No secrets on the glasses or in the browser',
    b: 'No exchange keys exist anywhere. The only server secret is the speech-service key, held by the backend. The glasses hold a revocable pairing token (only its hash is stored); the site holds your own session. You can remove a device any time.',
  },
  {
    t: 'Your data is yours',
    b: 'Row-level security lets each person read only their own limit, actions, fills and devices. All writes go through the server, which validates them. Wrong pairing codes are limited per person and globally.',
  },
  {
    t: 'A record of what happened',
    b: 'Executed cuts, failed orders, refused confirmations, limit changes and kill-switch changes are written to the actions log with time, size and result. Refusals at the first (propose) step, such as a blocked kill switch or an active cooldown, are not logged yet.',
  },
]

const LIMITS: { t: string; b: string }[] = [
  { t: 'Simulator-tested only', b: 'The glasses app is tested in the official Even Hub simulator and has not been verified on physical glasses. Swipe direction mapping, BLE update timing, font rendering and the microphone format on real hardware are unverified.' },
  { t: 'It is a simulation', b: 'Paper fills use the live bid and ask plus a fixed slippage and fee. They do not model order book depth, partial fills, funding or liquidation. Real trading would differ.' },
  { t: 'Browser-bound accounts', b: 'A paper account is an anonymous account in your browser. Clearing the site data loses access to it. There is no email or password recovery yet.' },
  { t: 'Free tiers', b: 'The backend runs on free tiers. Speech transcription is limited (about 20 requests per minute) with no uptime guarantee, which is why a gesture fallback always exists. An idle free backend can pause; a scheduled ping keeps the demo awake.' },
  { t: 'Public market data', b: 'Five markets, priced from one public source. If that source is down, Haltline shows NO PRICES rather than guessing.' },
  { t: 'Voice privacy', b: 'When you use voice, the recording is sent to the speech-to-text provider through the Haltline backend. Haltline does not store it.' },
]

export default function Safety() {
  return (
    <>
      <PageHead title="Safety" lead="What stops one stray press, one bad price or one panicked moment from doing damage, and where the limits of this project are." />
      <Section kicker="Enforced rules" title="What the system does">
        <div className="rules-grid">
          {RULES.map((r, i) => (
            <Reveal key={r.t} delay={(i % 3) * 60} className="rule card">
              <h3>{r.t}</h3>
              <p className="muted">{r.b}</p>
            </Reveal>
          ))}
        </div>
      </Section>
      <Section kicker="Be clear-eyed" title="Honest limitations">
        <div className="rules-grid">
          {LIMITS.map((r, i) => (
            <Reveal key={r.t} delay={(i % 3) * 60} className="rule card">
              <h3>{r.t}</h3>
              <p className="muted">{r.b}</p>
            </Reveal>
          ))}
        </div>
      </Section>
      <Section>
        <Reveal>
          <div className="card disclaimer">
            <h2>Disclaimer</h2>
            <p>
              Haltline is a hackathon project. It runs on a <strong>simulated paper account only</strong>: no real funds are held, no order ever
              reaches a real exchange, and nothing here is financial advice or a recommendation to trade. Do not rely on it to manage real
              money.
            </p>
            <p className="muted">See the <Link to="/docs">docs</Link> for exactly how the paper account prices fills.</p>
          </div>
        </Reveal>
      </Section>
    </>
  )
}
