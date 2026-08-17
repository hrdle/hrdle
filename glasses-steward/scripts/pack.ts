#!/usr/bin/env bun
/**
 * Pack the ehpk, refusing to ship a bundle that disagrees with the manifest.
 *
 * The version reaches the running app through the bundle (injected at build
 * time from app.json) and reaches the store through app.json itself. Bump the
 * manifest without rebuilding and the two part company silently: the Hub lists
 * one number and the device reports another, which is worse than no number at
 * all because it looks authoritative.
 */
import { $ } from 'bun'

const manifest = await Bun.file('app.json').json()
const want = manifest.version as string

let bundles: string[] = []
try {
  bundles = [...new Bun.Glob('assets/*.js').scanSync('dist')]
} catch {
  // scanSync throws rather than returning empty when dist/ is not there.
}
if (bundles.length === 0) {
  console.error('✗ dist/ has no bundle. Run `bun run build` first.')
  process.exit(1)
}

const marker = /main: v([0-9][0-9.]*) \(([^)]*)\)/
const found = new Set<string>()
const commits = new Set<string>()
for (const rel of bundles) {
  const m = marker.exec(await Bun.file(`dist/${rel}`).text())
  if (m) {
    found.add(m[1])
    commits.add(m[2])
  }
}

if (found.size === 0) {
  console.error('✗ No version marker in the bundle. Is the build current?')
  process.exit(1)
}
if (found.size > 1 || !found.has(want)) {
  console.error(`✗ app.json says ${want}, the bundle says ${[...found].join(', ')}.`)
  console.error('  The build is stale — run `bun run build` and pack again.')
  process.exit(1)
}

// A version number can be reused; a commit cannot. Shipping a build whose
// source was uncommitted leaves the device naming a commit it does not match,
// and nothing on the Hub or the device can tell afterwards which code it was.
const commit = [...commits][0] ?? 'nogit'
if (commit.endsWith('+dirty')) {
  console.error(`✗ The bundle was built from uncommitted source (${commit}).`)
  console.error('  Commit glasses/src (and shared/) first, rebuild, then pack —')
  console.error('  otherwise the version on the device points at code that never existed.')
  process.exit(1)
}
if (commit === 'nogit') {
  console.warn('! No repository at build time: the bundle cannot name its commit.')
}

console.log(`✓ app.json and bundle agree on v${want} (${commit})`)
await $`bunx --bun evenhub pack app.json dist`
