import { createClient } from '@supabase/supabase-js'
import { CONFIGURED, SUPABASE_ANON_KEY, SUPABASE_URL } from './env.ts'

export const supabase = CONFIGURED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
  : null
