// Build-time configuration. Both values are public by design (project URL and the
// publishable key); no secret ever ships in this app.
const env = import.meta.env as Record<string, string | undefined>

export const SUPABASE_URL: string = (env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
export const SUPABASE_ANON_KEY: string = env.VITE_SUPABASE_ANON_KEY ?? ''
export const CONFIGURED: boolean = SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 0

export const TOKEN_STORAGE_KEY = 'haltline_device_token'
