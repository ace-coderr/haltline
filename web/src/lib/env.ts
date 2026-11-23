// Public configuration only (project URL and publishable key). No secrets ship in the site.
const env = import.meta.env as Record<string, string | undefined>
export const SUPABASE_URL: string = (env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
export const SUPABASE_ANON_KEY: string = env.VITE_SUPABASE_ANON_KEY ?? ''
export const CONFIGURED: boolean = SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 0
export const REPO_URL = 'https://github.com/ace-coderr/haltline'
export const asset = (name: string): string => `${import.meta.env.BASE_URL}${name}`
