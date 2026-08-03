// The app with nothing behind it.
//
// A reviewer has no herdr server and is not going to install one, so the app
// they were asked to judge was a paragraph of setup instructions. The demo is
// the same app on canned data — same screens, same gestures, same controller —
// which is the point: a second implementation of every transition would drift,
// and the ones that drift are always the ones nobody is looking at.
//
// What it must not do is pass for the real thing. The reviewer has to be able
// to see that setup is still outstanding, which is the first-run rule this
// exists to satisfy.

import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import { screenText } from '../display.ts'
import { demoChoices, demoConversation, demoSessions } from '../demo.ts'
import type { GlassesPlatform } from '../controller.ts'

function platform(): GlassesPlatform & { exits: number } {
  const p = {
    onDevice: false,
    exits: 0,
    render() {},
    renderHeader() {},
    requestExit() { p.exits++ },
  }
  return p as unknown as GlassesPlatform & { exits: number }
}

describe('the demo', () => {
  test('fills the list without a socket', () => {
    const p = platform()
    const c = new GlassesController(p)
    c.startDemo()
    expect(c.state.sessions).toHaveLength(demoSessions().length)
    expect(c.state.mode).toBe('session_list')
    // Nothing was connected, so nothing can have been sent.
    expect(c.ws.getState()).toBe('null')
  })

  test('says so on every screen it can reach', () => {
    const p = platform()
    const c = new GlassesController(p)
    c.startDemo()
    expect(screenText(c.state).footer).toContain('DEMO')

    c.state.mode = 'conversation'
    c.state.conversation = demoConversation()
    expect(screenText(c.state).header).toContain('DEMO')

    c.state.mode = 'choice'
    c.state.choiceOptions = demoChoices()
    expect(screenText(c.state).header).toContain('DEMO')
  })

  test('the root double-tap asks the same question it asks anywhere', () => {
    // A demo root is still a root. Routing it somewhere else would make the
    // one screen a reviewer reaches first the one place the gesture means
    // something other than what it means everywhere else.
    const p = platform()
    const c = new GlassesController(p)
    c.startDemo()
    c.doubleTap()
    expect(p.exits).toBe(1)
  })

  test('leaving takes the canned data with it', () => {
    const p = platform()
    const c = new GlassesController(p)
    c.startDemo()
    c.stopDemo()
    expect(c.state.sessions).toEqual([])
    expect(c.state.conversation).toEqual([])
    expect(c.state.demo).toBe(false)
    // And the root double-tap is what it always was.
    c.doubleTap()
    expect(p.exits).toBe(1)
  })

  test('offers a multi-select, which is the screen with the most to show', () => {
    // A cursor, a toggle, a count and a row that sends — and the picker that
    // was broken until today.
    expect(demoChoices().every((o) => o.startsWith('[ ]'))).toBe(true)
    expect(demoChoices().length).toBeGreaterThan(1)
  })

  test('a demo session is waiting, so there is something to answer', () => {
    expect(demoSessions().some((s) => s.indicatorState === 'waiting_input')).toBe(true)
    expect(demoSessions().some((s) => s.indicatorState === 'processing')).toBe(true)
  })
})
