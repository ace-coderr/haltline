import { Link } from 'react-router-dom'
import { PageHead, Reveal, Section, Shot } from '../components/ui.tsx'
import { asset } from '../lib/env.ts'

const BASE = asset('')

interface Step {
  n: string
  title: string
  body: string[]
  shots: { file: string; alt: string; cap: string }[]
  cta?: { to: string; label: string }
}

const STEPS: Step[] = [
  {
    n: '1',
    title: 'Pair',
    body: [
      'Open Haltline on your Even G2 glasses. Until they are linked to your account they show a 6-digit code.',
      'Enter it on the Pair page. Codes last 10 minutes, and wrong guesses are rate limited per person and globally, so the code space cannot be brute-forced. The glasses then keep a revocable token; you can remove a device any time.',
    ],
    shots: [{ file: 'glasses-pairing.png', alt: 'Glasses showing a six-digit pairing code', cap: 'The pairing screen.' }],
    cta: { to: '/pair', label: 'Pair a device' },
  },
  {
    n: '2',
    title: 'Set a limit',
    body: [
      'Your daily loss limit is the most you are willing to lose in one UTC day. Fees count; gains offset losses.',
      'Set it on the Limits page, or on the glasses: swipe on the idle screen and say "set limit five hundred". You confirm with a press before anything is saved. If voice is unavailable, a swipe-only stepper takes over.',
    ],
    shots: [
      { file: 'glasses-listening.png', alt: 'Glasses listening for a spoken limit', cap: 'Listening.' },
      { file: 'glasses-voice-confirm.png', alt: 'Glasses asking to confirm a spoken limit of 500 dollars', cap: 'Confirm before it is saved.' },
    ],
    cta: { to: '/limits', label: 'Open Limits' },
  },
  {
    n: '3',
    title: 'Watch',
    body: [
      'One giant number: how much you can still lose today. A gauge fills as you use the limit. At about 80% used it reads CLOSING IN and adds the word CLOSE.',
      'Prices are live public market data. If they are older than 15 seconds, or the connection drops, the number is replaced by NO PRICES or OFFLINE. It never keeps showing an old figure as if it were live.',
    ],
    shots: [
      { file: 'glasses-calm.png', alt: 'Calm state', cap: 'Calm.' },
      { file: 'glasses-closing.png', alt: 'Closing-in state', cap: 'Closing in.' },
    ],
    cta: { to: '/positions', label: 'Open the paper account' },
  },
  {
    n: '4',
    title: 'Act',
    body: [
      'At the limit the action menu opens by itself with CUT HALF? preselected. Any swipe moves to the next choice; a press selects it. Cut half and cut all lead to a confirm screen that says exactly what will happen, for example BUY 1.500 ETHUSD, reduces short.',
      'A press in the first 0.9 seconds is ignored as a stray press. A swipe cancels. After a confirmed cut there is a 60 second cooldown, and the kill switch can refuse all writes. Orders are reduce-only on the paper account, and every action is logged.',
    ],
    shots: [
      { file: 'glasses-tripped.png', alt: 'Tripped state with the action menu', cap: 'Limit reached.' },
      { file: 'glasses-confirm.png', alt: 'Confirm screen: cut half, buy 1.500 ETHUSD, reduces short', cap: 'The confirm step.' },
      { file: 'glasses-done.png', alt: 'Result: done, one order', cap: 'Done.' },
    ],
    cta: { to: '/activity', label: 'See the actions log' },
  },
]

export default function HowItWorks() {
  return (
    <>
      <PageHead title="How it works" lead="Pair, set a limit, watch one number, act with one confirmed gesture. All screens below are real captures from the official Even Hub simulator." />
      {STEPS.map((s) => (
        <Section key={s.n} className="how-step">
          <div className="how-row">
            <Reveal className="how-copy">
              <span className="step-n mono">0{s.n}</span>
              <h2>{s.title}</h2>
              {s.body.map((p) => <p key={p} className="muted">{p}</p>)}
              {s.cta && <Link to={s.cta.to} className="btn btn-sm">{s.cta.label}</Link>}
            </Reveal>
            <Reveal className={`how-shots shots-${s.shots.length}`} delay={80}>
              {s.shots.map((sh) => <Shot key={sh.file} base={BASE} file={sh.file} alt={sh.alt} caption={sh.cap} />)}
            </Reveal>
          </div>
        </Section>
      ))}

      <Section kicker="Reference" title="Controls">
        <div className="two-col">
          <Reveal>
            <div className="card">
              <table className="table">
                <thead><tr><th>Gesture</th><th>Does</th></tr></thead>
                <tbody>
                  <tr><td><strong>Press</strong></td><td>Open the action menu, select, confirm.</td></tr>
                  <tr><td><strong>Swipe</strong></td><td>Next choice. On an idle screen: start listening. On a confirm: cancel.</td></tr>
                  <tr><td><strong>Double press</strong></td><td>Exits the app (the platform does this; Haltline never uses it as an action).</td></tr>
                </tbody>
              </table>
            </div>
          </Reveal>
          <Reveal delay={80}>
            <div className="card">
              <h3>Honest status</h3>
              <p className="muted">
                Tested in the official Even Hub simulator; <strong>not yet verified on physical glasses</strong>. Swipe direction mapping, BLE
                update timing, font rendering and the microphone format on real hardware are unverified. That is why direction is ignored
                (any swipe cycles) and a swipe on a confirm only cancels.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  )
}
