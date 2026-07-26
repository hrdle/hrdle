import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
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
