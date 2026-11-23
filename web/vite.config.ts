import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages serves the site from /haltline/ (ace-coderr.github.io/haltline); dev uses /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/haltline/' : '/',
  plugins: [react()],
}))
