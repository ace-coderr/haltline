export function usd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--'
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** Whole dollars, rounded DOWN, like the glasses: headroom is never overstated. */
export function usdWhole(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--'
  return `$${Math.floor(Math.max(0, n) + 1e-9).toLocaleString('en-US')}`
}

export function signed(n: number, digits = 2): string {
  return `${n > 0 ? '+' : ''}${usd(n, digits)}`
}

export function price(n: number): string {
  const digits = n >= 1000 ? 2 : n >= 1 ? 3 : 6
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })
}

export function qty(n: number, step?: number): string {
  const decimals = step && step < 1 ? Math.min(8, Math.round(-Math.log10(step))) : 0
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, 4) })
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function timeOf(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The digits of a pairing code, from whatever the user typed or pasted (at most six). */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6)
}

export const isValidCode = (code: string): boolean => /^\d{6}$/.test(code)

/** Parses a user-typed number (accepts $ and commas). Returns null for anything unusable. */
export function parseAmount(raw: string): number | null {
  const t = raw.trim().replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** A fresh idempotency key (24 hex chars) for one deliberate click. */
export function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const LIMIT_MIN = 1
export const LIMIT_MAX = 1_000_000
