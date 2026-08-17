import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { IDENTITY } from '../shared/identity'

// Where the simulator proxies API and WS traffic during development. Both the
// override variable and the fallback port come from identity: spelled out,
// they keep pointing at the previous product's dev server after a rename.
const OVERRIDE_ENV = `${IDENTITY.binaryName.toUpperCase()}_URL`
const BACKEND_URL =
  process.env[OVERRIDE_ENV] || `https://localhost:${IDENTITY.devPort}`

const APP_VERSION = JSON.parse(readFileSync(new URL('./app.json', import.meta.url), 'utf-8')).version

/**
 * The commit this bundle was built from.
 *
 * A version number says which number a build claims, not which code it
 * contains. `+dirty` means the source had uncommitted edits at build time, so
 * the hash names a commit the bundle does not actually match.
 */
function buildCommit(): string {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf-8' }).trim()
  try {
    const head = git(['rev-parse', '--short', 'HEAD'])
    const dirty = git(['status', '--porcelain', '--', 'src', '../shared']).length > 0
    return dirty ? `${head}+dirty` : head
  } catch {
    return 'nogit'
  }
}

const BUILD_COMMIT = buildCommit()

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    // Injected rather than imported: this bundle deliberately keeps no
    // dependency on shared/ (see the mirrored types in src/types.ts), and the
    // ehpk is shipped to a device where every KB counts.
    __DEFAULT_PORT__: JSON.stringify(IDENTITY.defaultPort),
    __PRODUCT_NAME__: JSON.stringify(IDENTITY.productName),
    __BINARY_NAME__: JSON.stringify(IDENTITY.binaryName),
    __REPO__: JSON.stringify(IDENTITY.repo),
    // The same prefix the other app writes under, deliberately. See
    // `resolveServerUrl` in main.ts: if the host keeps one store across
    // packages, an address already set up over there is simply here, and if it
    // does not, this app asks for one once.
    __STORAGE_PREFIX__: JSON.stringify(IDENTITY.storagePrefix),
  },
  publicDir: mode === 'device' ? false : 'public',
  build: {
    outDir: 'dist',
  },
  server: {
    host: '0.0.0.0',
    // One above the other glasses app's, so both simulators can be up at once
    // - which is exactly what the two-apps-installed case needs looking at.
    port: 8392,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        secure: false,
        changeOrigin: true,
      },
      '/ws/mux': {
        target: BACKEND_URL,
        secure: false,
        ws: true,
        changeOrigin: true,
      },
    },
  },
}))
