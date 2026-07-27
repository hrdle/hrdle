import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// The ehpk version, from the one file that decides it. Twice today the
// question "which build is on the device?" had to be answered by comparing a
// log timestamp against when a build was promoted, which is a guess wearing a
// number. Baked in at build time so the app can say it outright, and read
// from app.json so it cannot drift from what was packed.
const APP_VERSION = JSON.parse(readFileSync(new URL('./app.json', import.meta.url), 'utf-8')).version

export default defineConfig(({ mode }) => ({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  // public/ holds the simulator's backdrop photo, which only the web build
  // wants: the G2 bundle has no browser simulator, and the ehpk is shipped to
  // the device where every KB is dead weight. `--mode device` drops it.
  publicDir: mode === 'device' ? false : 'public',
  build: {
    outDir: 'dist',
  },
  server: {
    host: '0.0.0.0',
    port: 8391,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.CCHUB_URL || 'https://localhost:3456',
        secure: false,
        changeOrigin: true,
      },
      '/ws/mux': {
        target: process.env.CCHUB_URL || 'https://localhost:3456',
        secure: false,
        ws: true,
        changeOrigin: true,
      },
    },
  },
}))
