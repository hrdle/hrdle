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
import { DEMO_REPLY_MS, demoChoices, demoConversation, demoSessions, demoTranscript } from '../demo.ts'
import type { GlassesPlatform } from '../controller.ts'

function platform(): GlassesPlatform & { exits: number; micStarts: number } {
  const p = {
    onDevice: false,
    exits: 0,
    micStarts: 0,
    render() {},
    renderHeader() {},
    requestExit() { p.exits++ },
    async startMicCapture() { p.micStarts++; return true },
    async stopMicCapture() {},
    async transcribeAudio() { throw new Error('a demo has no server to transcribe against') },
  }
  return p as unknown as GlassesPlatform & { exits: number; micStarts: number }
}

/** A ring gesture, awaited. The public methods are fire-and-forget because the
 *  host has nothing to await; a test does. */
function ring(c: GlassesController, action: 'tap' | 'doubleTap' | 'swipeUp' | 'swipeDown'): Promise<void> {
  return (c as unknown as { handle(a: string): Promise<void> }).handle(action)
}

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** A workspace holding no question, so a tap goes to the microphone rather
 *  than to the picker. */
function quietSession(): number {
  return demoSessions().findIndex((s) => s.indicatorState === 'completed' && !s.panes)
}

function lastMessage(c: GlassesController) {
  return c.state.conversation[c.state.conversation.length - 1]
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

  test('a spoken answer is recognized and the conversation moves on', async () => {
    // The one thing this app is for - answering an agent without a keyboard -
    // and it used to stop one step short of showing that the words got out of
    // the panel: the send said what it would have done and nothing happened.
    const p = platform()
    const c = new GlassesController(p)
    c.startDemo()
    // A workspace that is not holding a question, so a tap goes to the mic
    // rather than to the picker.
    c.state.sessionIndex = quietSession()
    await ring(c, 'tap')
    expect(c.state.mode).toBe('conversation')

    await ring(c, 'tap')
    expect(c.state.mode).toBe('voice')
    expect(c.state.voicePhase).toBe('recording')
    // Transcription is the server's job and there is no server: opening the
    // microphone could only ever arrive at "(nothing was recognized)".
    expect(p.micStarts).toBe(0)

    await ring(c, 'tap')
    expect(c.state.voicePhase).toBe('confirm')
    expect(c.state.voiceText).toBe(demoTranscript())

    await ring(c, 'tap')
    await settle()
    expect(c.state.mode).toBe('conversation')
    expect(lastMessage(c)).toMatchObject({ role: 'user', content: demoTranscript() })

    await settle(DEMO_REPLY_MS + 50)
    expect(lastMessage(c)?.role).toBe('assistant')
    expect(lastMessage(c)?.content).toContain(demoTranscript())
  })

  test('a picked option ticks its box and is answered with', async () => {
    const p = platform()
    const c = new GlassesController(p)
    c.startDemo()
    // The workspace that is waiting on an answer.
    c.state.sessionIndex = demoSessions().findIndex((s) => s.indicatorState === 'waiting_input')
    await ring(c, 'tap')
    await ring(c, 'tap')
    expect(c.state.mode).toBe('choice')
    expect(c.state.choiceMulti).toBe(true)

    // No pane to read the box back from, so the toggle has to be visible here
    // or the screen that exists to demonstrate it demonstrates nothing.
    await ring(c, 'tap')
    expect(c.state.choiceOptions[0]).toStartWith('[x]')

    // Down to the send row, past the options.
    for (let i = 0; i < demoChoices().length; i++) await ring(c, 'swipeDown')
    await ring(c, 'tap')
    await settle()
    expect(c.state.mode).toBe('conversation')
    expect(lastMessage(c)).toMatchObject({ role: 'user', content: demoChoices()[0].replace('[ ] ', '') })

    await settle(DEMO_REPLY_MS + 50)
    expect(lastMessage(c)?.role).toBe('assistant')
  })

  test('leaving takes a reply still in flight with it', async () => {
    // The agent's answer arrives on a timer. Leaving the demo before it lands
    // would otherwise drop a canned message onto whatever is on screen next.
    const p = platform()
    const c = new GlassesController(p)
    c.startDemo()
    c.state.sessionIndex = quietSession()
    await ring(c, 'tap')
    await ring(c, 'tap')
    await ring(c, 'tap')
    await ring(c, 'tap')
    c.stopDemo()
    await settle(DEMO_REPLY_MS + 50)
    expect(c.state.conversation).toEqual([])
  })

  test('a demo session is waiting, so there is something to answer', () => {
    expect(demoSessions().some((s) => s.indicatorState === 'waiting_input')).toBe(true)
    expect(demoSessions().some((s) => s.indicatorState === 'processing')).toBe(true)
  })
})
