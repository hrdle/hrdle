import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

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
