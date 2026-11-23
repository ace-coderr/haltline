import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useReveal } from '../lib/hooks.ts'
import type { RiskState } from '../lib/api.ts'

export function PaperBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`paper-badge ${className}`} title="Simulated paper account. No real funds.">
      PAPER
    </span>
  )
}

/** Wraps content so it fades/slides in when scrolled into view. */
export function Reveal({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <div ref={ref} className={`reveal ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  )
}

export function Section({ id, title, kicker, children, className = '' }: { id?: string; title?: string; kicker?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`section ${className}`}>
      <div className="wrap">
        {(kicker || title) && (
          <Reveal className="section-head">
            {kicker && <p className="kicker">{kicker}</p>}
            {title && <h2>{title}</h2>}
          </Reveal>
        )}
        {children}
      </div>
    </section>
  )
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title
  }, [title])
}

export function PageHead({ title, lead, children }: { title: string; lead: string; children?: ReactNode }) {
  useTitle(`${title} · Haltline`)
  return (
    <header className="page-head wrap">
      <div className="page-head-row">
        <h1>{title}</h1>
        <PaperBadge />
      </div>
      <p className="lead">{lead}</p>
      {children}
    </header>
  )
}

const STATE_LABEL: Record<RiskState, string> = { CALM: 'CALM', CLOSING: 'CLOSING IN', TRIPPED: 'TRIPPED', NO_LIMIT: 'NO LIMIT' }

export function StateChip({ state }: { state: RiskState }) {
  return <span className={`chip state-${state.toLowerCase()}`}>{STATE_LABEL[state]}</span>
}

export function Gauge({ fraction, state }: { fraction: number | null; state: RiskState }) {
  const pct = fraction === null ? 0 : Math.max(0, Math.min(1, fraction)) * 100
  return (
    <div className={`gauge state-${state.toLowerCase()}`} role="img" aria-label={`${Math.round(pct)} percent of the daily loss limit used`}>
      <div className="gauge-fill" style={{ width: `${pct}%` }} />
      <div className="gauge-mark" style={{ left: '80%' }} title="80%: closing in" />
    </div>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value mono ${tone ?? ''}`}>{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  )
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'ok' | 'warn'; children: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
    </div>
  )
}

export function Shot({ file, alt, caption, base }: { file: string; alt: string; caption?: string; base: string }) {
  return (
    <figure className="shot">
      <div className="lens">
        <img src={`${base}${file}`} alt={alt} width={576} height={288} loading="lazy" decoding="async" />
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}
