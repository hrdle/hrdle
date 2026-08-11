import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { IDENTITY } from '../shared/identity'

// Where the simulator proxies API and WS traffic during development. Both the
// override variable and the fallback port come from identity (#459): spelled
// out, they keep pointing at the previous product's dev server after a rename.
const OVERRIDE_ENV = `${IDENTITY.binaryName.toUpperCase()}_URL`
const BACKEND_URL =
  process.env[OVERRIDE_ENV] || `https://localhost:${IDENTITY.devPort}`

// The ehpk version, from the one file that decides it. Twice today the
// question "which build is on the device?" had to be answered by comparing a
// log timestamp against when a build was promoted, which is a guess wearing a
// number. Baked in at build time so the app can say it outright, and read
// from app.json so it cannot drift from what was packed.
const APP_VERSION = JSON.parse(readFileSync(new URL('./app.json', import.meta.url), 'utf-8')).version

/**
 * The commit this bundle was built from.
 *
 * A version number says which number a build claims, not which code it
 * contains: main can move past the last packed ehpk while `app.json` still
 * reads the same, and then two different bundles both answer "v0.1.51". The
 * hash cannot do that.
 *
 * `+dirty` means the source had uncommitted edits at build time, so the hash
 * names a commit the bundle does not actually match. Only `src/` and the
 * shared types count: `app.json` and `out.ehpk` are modified as a normal part
 * of every release, and flagging those would make the mark meaningless.
 */
function buildCommit(): string {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf-8' }).trim()
  try {
    const head = git(['rev-parse', '--short', 'HEAD'])
    const dirty = git(['status', '--porcelain', '--', 'src', '../shared']).length > 0
    return dirty ? `${head}+dirty` : head
  } catch {
    // A tarball with no .git, or no git at all. Say so rather than invent one.
    return 'nogit'
  }
}

const BUILD_COMMIT = buildCommit()

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    // Injected rather than imported: glasses/src deliberately keeps no
    // dependency on shared/ (see the mirrored types in src/types.ts), and the
    // ehpk is shipped to a device where every KB counts. It still has to come
    // from identity — the phone UI completes a port-less URL with it, so a
    // literal would keep pointing the device at the previous product (#459).
    __DEFAULT_PORT__: JSON.stringify(IDENTITY.defaultPort),
    // The rest of the rename surface, for the same reason. The hrdle → hrdle
    // switch found all of this spelled out inline: a product name in six
    // screens, an install command, two repository links, four storage keys.
    // None of it is a name anyone chose independently — it is all the same
    // rename, so it comes from the same file.
    //
    // `app.json` is the one place that cannot: `package_id` and `name` are read
    // by the packer and the Hub before any bundle exists, and the Hub treats
    // `package_id` as immutable — a new one is a new project, not a renamed
    // one. So that file is edited by hand and left out of this list.
    __PRODUCT_NAME__: JSON.stringify(IDENTITY.productName),
    __BINARY_NAME__: JSON.stringify(IDENTITY.binaryName),
    __REPO__: JSON.stringify(IDENTITY.repo),
    __STORAGE_PREFIX__: JSON.stringify(IDENTITY.storagePrefix),
  },
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
