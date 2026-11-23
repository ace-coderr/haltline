import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PaperBadge, Reveal, Section, Shot, useTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { asset } from '../lib/env.ts'
import { ago, price } from '../lib/format.ts'
import { usePoll } from '../lib/hooks.ts'

const BASE = asset('')

/** Real, live paper-market prices (public endpoint, no sign-in). */
function LiveTicker() {
  const q = usePoll(api.prices, 5000)
  const rows = q.data?.quotes.slice(0, 3) ?? []
  return (
    <div className="ticker" aria-live="polite">
      <div className="ticker-head">
        <span className="ticker-dot" aria-hidden="true" />
        <span>Live paper market data</span>
        <PaperBadge />
      </div>
      {q.loading && !q.data && <p className="muted small">Loading prices…</p>}
      {q.error && !q.data && <p className="muted small">Live prices are unavailable right now.</p>}
      {rows.map((r) => (
        <div className="ticker-row" key={r.symbol}>
          <span>{r.base}/USD</span>
          <span className="mono">{price(r.bid)}</span>
          <span className="mono muted">{price(r.ask)}</span>
          <span className="muted small">{ago(r.ageMs)}</span>
        </div>
      ))}
      {q.data && <p className="muted small ticker-foot">Bid, ask, age. {q.data.source}.</p>}
    </div>
  )
}

function Hero() {
  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <p className="kicker">Risk guard for Even G2 glasses</p>
          <h1>
            See how much you can still lose today. <span className="g">Without picking up a phone.</span>
          </h1>
          <p className="lead">
            Haltline puts one number in front of you: the distance to <em>your own</em> daily loss limit, with a gauge that fills as you get
            close. When you hit it, one confirmed gesture cuts your positions.
          </p>
          <div className="hero-cta">
            <Link to="/pair" className="btn btn-primary">Pair your glasses</Link>
            <Link to="/how-it-works" className="btn">How it works</Link>
          </div>
          <p className="muted small hero-note">
            Paper trading only: a simulated account priced from live public market data. No real funds, not financial advice.
          </p>
        </div>
        <div className="hero-visual">
          <div className="float-card">
            <Shot base={BASE} file="glasses-calm.png" alt="Glasses display in the calm state: a large dollar amount left to lose today and a short gauge line" />
            <LiveTicker />
          </div>
        </div>
      </div>
    </section>
  )
}

const FACTS = [
  { big: '576×288', label: 'monochrome green display', note: 'one giant number, nothing else' },
  { big: '0', label: 'real funds, ever', note: 'paper account, public prices' },
  { big: '80%', label: 'used flips to CLOSING IN', note: 'before you reach the limit' },
  { big: '20s · 60s', label: 'to confirm · between actions', note: 'plus a stray-press guard' },
]

function Facts() {
  return (
    <section className="facts">
      <div className="wrap facts-grid">
        {FACTS.map((f, i) => (
          <Reveal key={f.label} delay={i * 70} className="fact">
            <span className="fact-big mono">{f.big}</span>
            <span className="fact-label">{f.label}</span>
            <span className="muted small">{f.note}</span>
          </Reveal>
        ))}
      </div>
    </section>
  )
}

type Module = 'Limits' | 'Positions' | 'Voice'
const MODULES: { tag: Module; title: string; body: string; to: string }[] = [
  { tag: 'Limits', title: 'Your limit, counted down', body: 'Set a daily loss limit once. The glasses show what is left, fees included, and flip to CLOSING IN at 80%.', to: '/limits' },
  { tag: 'Limits', title: 'A kill switch that stays off the glasses', body: 'One switch on the website refuses every write from the glasses. The glasses cannot turn it back on.', to: '/limits' },
  { tag: 'Positions', title: 'A real paper account to guard', body: 'Open and close long and short positions at live public prices, with a stated fee, spread and slippage.', to: '/positions' },
  { tag: 'Positions', title: 'Cut half. Cut all. Dismiss.', body: 'Swipe to choose, press to confirm. Orders are reduce-only, so a cut can never grow a position.', to: '/how-it-works' },
  { tag: 'Positions', title: 'Every action on the record', body: 'The server logs each cut, refusal and settings change with time, size and result.', to: '/activity' },
  { tag: 'Voice', title: 'Say it: "set limit five hundred"', body: 'Hands-free limit setting through speech transcription. You always confirm before anything is saved.', to: '/docs' },
  { tag: 'Voice', title: 'Gesture fallback, always', body: 'If voice is down or rate limited, the screen says so and a swipe-only stepper takes over.', to: '/docs' },
]

function Modules() {
  const [filter, setFilter] = useState<'All' | Module>('All')
  const shown = MODULES.filter((m) => filter === 'All' || m.tag === filter)
  return (
    <Section id="modules" kicker="What it does" title="Three modules, one job: know your limit and act on it">
      <div className="chips" role="group" aria-label="Filter modules">
        {(['All', 'Limits', 'Positions', 'Voice'] as const).map((f) => (
          <button key={f} className={`chip chip-btn ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <div className="module-grid">
        {shown.map((m) => (
          <Link key={m.title} to={m.to} className="module card">
            <span className="chip">{m.tag}</span>
            <h3>{m.title}</h3>
            <p className="muted">{m.body}</p>
            <span className="module-more">Open →</span>
          </Link>
        ))}
      </div>
    </Section>
  )
}

const PANELS = [
  { tone: 'calm', file: 'glasses-calm.png', title: 'Calm', body: 'Plenty of room. One number: what you can still lose today. A short gauge. Nothing to do.', alt: 'Calm state: a large amount left and a short gauge' },
  { tone: 'closing', file: 'glasses-closing.png', title: 'Closing in', body: 'Around 80% of your limit used. The same number, now with the word CLOSE. Time to decide.', alt: 'Closing-in state: a small amount left, a long gauge and the word CLOSE' },
  { tone: 'tripped', file: 'glasses-tripped.png', title: 'Tripped', body: 'Limit reached. The menu opens by itself with CUT HALF? preselected. Swipe to change, press to confirm.', alt: 'Tripped state: LIMIT REACHED with a full gauge and the choices cut half, cut all, dismiss' },
]

function States() {
  return (
    <Section id="states" kicker="Three states" title="Calm, closing in, tripped" className="states">
      <p className="lead">Real captures from the official Even Hub simulator, rendering the live app against the live backend.</p>
      <div className="stack-panels">
        {PANELS.map((p, i) => (
          <article key={p.tone} className={`stack-panel tone-${p.tone}`} style={{ top: `${88 + i * 18}px` }}>
            <div className="stack-copy">
              <span className={`chip state-${p.tone}`}>{p.title}</span>
              <h3>{p.title}</h3>
              <p className="muted">{p.body}</p>
            </div>
            <Shot base={BASE} file={p.file} alt={p.alt} />
          </article>
        ))}
      </div>
    </Section>
  )
}

const STEPS = [
  { n: '01', title: 'Pair', body: 'The glasses show a 6-digit code. Enter it on the Pair page. No password, no email.', to: '/pair' },
  { n: '02', title: 'Set a limit', body: 'Type your daily loss limit on the site or say it to the glasses.', to: '/limits' },
  { n: '03', title: 'Watch', body: 'Glance at one number: what you can still lose today.', to: '/positions' },
  { n: '04', title: 'Act', body: 'At the limit, swipe to choose and press to confirm. Reduce-only, with a cooldown.', to: '/how-it-works' },
]

function Steps() {
  return (
    <Section id="steps" kicker="How it works" title="Four steps">
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.n}>
            <Reveal delay={i * 80}>
              <Link to={s.to} className="step card">
                <span className="step-n mono">{s.n}</span>
                <h3>{s.title}</h3>
                <p className="muted">{s.body}</p>
              </Link>
            </Reveal>
          </li>
        ))}
      </ol>
    </Section>
  )
}

const RULES = [
  { t: 'Paper only, in code', b: 'The backend can only reach a public price feed and a speech service. A test scans the source for any real exchange.' },
  { t: 'Reduce-only cuts', b: 'A cut can close or shrink a position. It cannot open one or make it bigger.' },
  { t: 'Confirm, then wait', b: '20 seconds to confirm, a stray-press guard, then a 60 second cooldown, enforced atomically by the database.' },
  { t: 'Fails closed', b: 'Stale prices, a lost connection or bad data hide the number and block actions. It never shows CALM when it does not know.' },
  { t: 'Kill switch', b: 'Switch every write off from the website. The glasses cannot switch it back on.' },
  { t: 'Nothing secret on the device', b: 'The glasses hold a revocable pairing token, never an API key. You can remove a device any time.' },
]

function Rules() {
  return (
    <Section id="safety" kicker="Safety rules" title="Built so one stray press cannot do damage">
      <div className="rules-grid">
        {RULES.map((r, i) => (
          <Reveal key={r.t} delay={i * 60} className="rule card">
            <h3>{r.t}</h3>
            <p className="muted">{r.b}</p>
          </Reveal>
        ))}
      </div>
      <p><Link to="/safety">Read the full safety model →</Link></p>
    </Section>
  )
}

function Cta() {
  return (
    <section className="cta" style={{ backgroundImage: `linear-gradient(rgba(11,14,12,.78), rgba(11,14,12,.94)), url(${BASE}glasses-tripped.png)` }}>
      <div className="wrap cta-inner">
        <Reveal>
          <h2>Know your limit before it knows you.</h2>
          <p className="lead">Pair your glasses, set a limit, and trade with it in view. All on a paper account.</p>
          <div className="hero-cta">
            <Link to="/pair" className="btn btn-primary">Pair your glasses</Link>
            <Link to="/positions" className="btn">Open the paper account</Link>
          </div>
          <p className="muted small">Tested in the official Even Hub simulator; not yet verified on physical glasses.</p>
        </Reveal>
      </div>
    </section>
  )
}

export default function Home() {
  useTitle('Haltline · your daily loss limit, at a glance')
  return (
    <>
      <Hero />
      <Facts />
      <Modules />
      <States />
      <Steps />
      <Rules />
      <Cta />
    </>
  )
}
