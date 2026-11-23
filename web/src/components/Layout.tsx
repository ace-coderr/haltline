import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { REPO_URL } from '../lib/env.ts'

const NAV = [
  { to: '/how-it-works', label: 'How it works' },
  { to: '/limits', label: 'Limits' },
  { to: '/positions', label: 'Positions' },
  { to: '/activity', label: 'Activity' },
  { to: '/safety', label: 'Safety' },
  { to: '/docs', label: 'Docs' },
]

function Logo() {
  return (
    <Link to="/" className="brand" aria-label="Haltline home">
      <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
        <rect x="6" y="28" width="32" height="7" rx="3" fill="currentColor" />
        <rect x="38" y="28" width="18" height="7" rx="3" fill="currentColor" opacity=".35" />
        <rect x="38" y="14" width="7" height="36" rx="3" fill="currentColor" />
      </svg>
      <span>Haltline</span>
    </Link>
  )
}

export function Navbar() {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => {
    setOpen(false)
  }, [pathname])
  return (
    <header className="nav-shell">
      <nav className="nav wrap" aria-label="Main">
        <Logo />
        <ul className={`nav-links ${open ? 'open' : ''}`}>
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="nav-right">
          <span className="paper-badge" title="Simulated paper account. No real funds.">PAPER</span>
          <Link to="/pair" className="btn btn-sm btn-primary nav-cta">
            Pair glasses
          </Link>
          <button className="nav-toggle" aria-expanded={open} aria-controls="nav-links" aria-label="Menu" onClick={() => setOpen((o) => !o)}>
            <span />
            <span />
            <span />
          </button>
        </div>
      </nav>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-grid">
        <div>
          <Logo />
          <p className="muted small">Know how close you are to your own daily loss limit, without picking up a phone.</p>
        </div>
        <div>
          <h3>Product</h3>
          <ul>
            <li><Link to="/how-it-works">How it works</Link></li>
            <li><Link to="/limits">Limits</Link></li>
            <li><Link to="/positions">Positions</Link></li>
            <li><Link to="/activity">Activity</Link></li>
            <li><Link to="/pair">Pair a device</Link></li>
          </ul>
        </div>
        <div>
          <h3>Trust</h3>
          <ul>
            <li><Link to="/safety">Safety rules</Link></li>
            <li><Link to="/docs">Docs and API</Link></li>
            <li><a href={REPO_URL} target="_blank" rel="noreferrer">Source code</a></li>
          </ul>
        </div>
        <div className="footer-note">
          <h3>Read this</h3>
          <p className="small">
            <strong>Paper trading only.</strong> The account is simulated and priced from public market data. No real funds are held, nothing
            here is financial advice, and no order ever reaches a real exchange.
          </p>
          <p className="small muted">
            The glasses app is tested in the official Even Hub simulator and is not yet verified on physical glasses.
          </p>
        </div>
      </div>
    </footer>
  )
}

export function Layout() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [pathname])
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Navbar />
      <main id="main">
        <Outlet />
      </main>
      <Footer />
    </>
  )
}
