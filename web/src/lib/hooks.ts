import { useCallback, useEffect, useRef, useState } from 'react'

export interface PollState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  updatedAt: number | null
  refresh: () => void
}

/**
 * Calls `fn` now and then every `ms`, pausing while the tab is hidden. Never overlaps calls.
 * Old data is kept on error so the page can say "could not refresh" without blanking out.
 */
export function usePoll<T>(fn: () => Promise<T>, ms: number, enabled = true): PollState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const fnRef = useRef(fn)
  const busy = useRef(false)
  fnRef.current = fn

  const run = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      const d = await fnRef.current()
      setData(d)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    void run()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void run()
    }, ms)
    const onVisible = () => document.visibilityState === 'visible' && void run()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ms, enabled, run])

  return { data, error, loading, updatedAt, refresh: () => void run() }
}

/** Adds the `in` class once the element scrolls into view (CSS handles the animation). */
export function useReveal<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('in')
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        }
      },
      { threshold: 0.12 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return ref
}

/** Smoothly counts toward `target`. Reduced-motion users get the value immediately. */
export function useCountUp(target: number | null, ms = 700): number | null {
  const [v, setV] = useState<number | null>(target)
  const from = useRef<number>(target ?? 0)
  useEffect(() => {
    if (target === null) {
      setV(null)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setV(target)
      from.current = target
      return
    }
    const start = performance.now()
    const a = from.current
    let raf = 0
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      setV(a + (target - a) * e)
      if (k < 1) raf = requestAnimationFrame(tick)
      else from.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}
