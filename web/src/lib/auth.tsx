import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from './supabase.ts'

type Status = 'loading' | 'signed_out' | 'signed_in' | 'unconfigured'

interface AuthValue {
  status: Status
  userId: string | null
  /** Creates an anonymous paper account in this browser. Returns an error message, or null. */
  startAccount: () => Promise<string | null>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(supabase ? 'loading' : 'unconfigured')
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    let alive = true
    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      setUserId(data.session?.user.id ?? null)
      setStatus(data.session ? 'signed_in' : 'signed_out')
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUserId(session?.user.id ?? null)
      setStatus(session ? 'signed_in' : 'signed_out')
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const startAccount = useCallback(async (): Promise<string | null> => {
    if (!supabase) return 'This build has no backend address.'
    const { error } = await supabase.auth.signInAnonymously()
    if (!error) return null
    if (/anonymous/i.test(error.message)) return 'Anonymous accounts are switched off on this project.'
    if (error.status === 429 || /rate/i.test(error.message)) return 'Too many accounts were created from your network recently. Try again later.'
    return 'Could not create the account. Please try again.'
  }, [])

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut()
  }, [])

  const value = useMemo<AuthValue>(() => ({ status, userId, startAccount, signOut }), [status, userId, startAccount, signOut])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used inside AuthProvider')
  return v
}
