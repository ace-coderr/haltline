import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

// Content-Security-Policy for the published site (GitHub Pages cannot set headers, so it is a meta tag).
// Production builds only: the dev server needs inline scripts for hot reload.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const csp = (): Plugin => ({
  name: 'haltline-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer" content="no-referrer" />`),
})

// GitHub Pages serves the site from /haltline/ (ace-coderr.github.io/haltline); dev uses /.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/haltline/' : '/', // build and preview use the Pages path; dev uses /
  plugins: [react(), csp()],
}))
