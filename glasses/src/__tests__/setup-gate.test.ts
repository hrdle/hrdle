// The ring, on the screen that comes before a server exists.
//
// Everything that handles a gesture lives behind an await that only resolves
// once a server address has been stored. So the "not connected" screen had no
// working input of any kind — not a tap, not a swipe, and no way to close the
// app. An Even Hub reviewer, who has no server at all, met exactly that and
// reported it as double-tap failing to bring up the exit dialog (#148).
//
// The screen is drawn by `buildSetupGuide`, and what it promises has to be
// true.

import { describe, expect, test } from 'bun:test'

;(globalThis as unknown as { __PRODUCT_NAME__: string }).__PRODUCT_NAME__ = 'Hrdle'
;(globalThis as unknown as { __DEFAULT_PORT__: number }).__DEFAULT_PORT__ = 5924

const { buildSetupGuide } = await import('../display.ts')

describe('the setup guide', () => {
  const containers = (buildSetupGuide() as unknown as {
    textObject: { containerName: string; content: string }[]
  }).textObject

  const named = (name: string): string =>
    containers.find((c) => c.containerName === name)?.content ?? ''

  test('says what to do about it', () => {
    // #144: naming the failure without naming the fix reads as the app being
    // broken, and whoever meets this screen is meeting the app for the first
    // time.
    expect(named('body')).toContain('not connected')
    expect(named('body')).toContain('1. Start')
  })

  test('promises the way out, and the way in', () => {
    // The gestures are wired while the address is awaited, so the footer can
    // say so. Until they were, this screen was a room with no door - and a
    // reviewer with no server saw nothing else of the app.
    expect(named('footer')).toContain('dbl:exit')
    expect(named('footer')).toContain('tap:see how it works')
  })
})
