// Who decides that an item is worth the screen.
//
// It used to be this app, from its own mode: a new `waiting` item took the
// screen only from the session list, while an `info` item took it from the
// conversation too. So the thing needing an answer interrupted less than the
// thing reporting one, and on 2026-08-12 a question sat behind a two-line
// banner for ten minutes while the wearer read the very session asking it.
//
// The decision is `present` on the item now, computed server-side, and what is
// left here is the part only the device knows: do not take the panel from
// someone who is speaking into it or picking on it.

import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import type { GlassesRelayItem } from '../types.ts'

function platform(): GlassesPlatform {
  return {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() { return true },
    async stopMicCapture() {},
    async transcribeAudio() { throw new Error('not used here') },
  } as unknown as GlassesPlatform
}

type Internals = {
  onRelayUpsert(item: GlassesRelayItem): void
  onRelaySnapshot(items: GlassesRelayItem[]): void
}

const inner = (c: GlassesController) => c as unknown as Internals

/** Read without narrowing: a test that sets the mode first would otherwise be
 *  comparing against the literal it just assigned. */
const modeOf = (c: GlassesController): string => c.state.mode

function item(over: Partial<GlassesRelayItem> = {}): GlassesRelayItem {
  return {
    id: 'i1',
    kind: 'waiting',
    source: 'auto',
    sessionId: 's1',
    paneId: '%0',
    text: 'Which migration?',
    present: 'takeover',
    createdAt: 1,
    ...over,
  } as GlassesRelayItem
}

/** Reading session s1's conversation - two sessions exist, s1 is open. */
function reading(): GlassesController {
  const c = new GlassesController(platform())
  c.state.sessions = [
    { id: 's1', name: 'one', state: 'idle' },
    { id: 's2', name: 'two', state: 'idle' },
  ] as GlassesController['state']['sessions']
  c.state.sessionIndex = 0
  c.state.mode = 'conversation'
  return c
}

describe('what the server asks for', () => {
  test('a question takes the conversation of the session asking it', () => {
    // The incident itself. This view has the transcript, not the options, so
    // it is the screen a question is LEAST visible on.
    const c = reading()
    inner(c).onRelayUpsert(item({ sessionId: 's1' }))
    expect(modeOf(c)).toBe('overlay')
  })

  test('a notice yields to the session it is about', () => {
    const c = reading()
    inner(c).onRelayUpsert(item({ kind: 'info', present: 'takeover-if-elsewhere', sessionId: 's1' }))
    expect(modeOf(c)).toBe('conversation')
  })

  test('a notice about another session still interrupts', () => {
    const c = reading()
    inner(c).onRelayUpsert(item({ kind: 'info', present: 'takeover-if-elsewhere', sessionId: 's2' }))
    expect(modeOf(c)).toBe('overlay')
  })

  test('banner never interrupts', () => {
    const c = reading()
    inner(c).onRelayUpsert(item({ present: 'banner', sessionId: 's2' }))
    expect(modeOf(c)).toBe('conversation')
  })

  test('the session list takes anything short of a banner', () => {
    const c = reading()
    c.state.mode = 'session_list'
    inner(c).onRelayUpsert(item({ kind: 'info', present: 'takeover-if-elsewhere', sessionId: 's1' }))
    expect(modeOf(c)).toBe('overlay')
  })
})

describe('what the device still decides', () => {
  test('nothing takes the panel mid-utterance', () => {
    const c = reading()
    c.state.mode = 'voice'
    inner(c).onRelayUpsert(item())
    expect(modeOf(c)).toBe('voice')
  })

  test('nothing takes the panel mid-pick', () => {
    // The picker IS the input here; replacing it would answer nothing and lose
    // where the ring was resting.
    const c = reading()
    c.state.mode = 'choice'
    inner(c).onRelayUpsert(item({ sessionId: 's2' }))
    expect(modeOf(c)).toBe('choice')
  })
})

describe('a dark panel', () => {
  test('a notice about the open conversation relights a sleeping panel', () => {
    // The lit-panel rule ("the reader can already see this") has no ground to
    // stand on when the panel is dark: the reader sees nothing. Measured
    // before this rule: every completion notice arriving while the panel
    // slept on its own conversation was dropped, and the wearer learned of
    // each one by waking the panel by hand.
    const c = reading()
    c.state.screenOff = true
    inner(c).onRelayUpsert(item({ kind: 'info', present: 'takeover-if-elsewhere', sessionId: 's1' }))
    expect(modeOf(c)).toBe('overlay')
    expect(c.state.screenOff).toBe(false)
  })

  test('a sleeping session list relights too', () => {
    const c = reading()
    c.state.mode = 'session_list'
    c.state.screenOff = true
    inner(c).onRelayUpsert(item({ kind: 'info', present: 'takeover-if-elsewhere', sessionId: 's1' }))
    expect(modeOf(c)).toBe('overlay')
    expect(c.state.screenOff).toBe(false)
  })

  test('lit, the same notice still yields to the conversation it is about', () => {
    // The guard the dark case walks past must hold when the panel is lit —
    // remove the whole block and this fails with the two suppression tests
    // beside it; removing only `!screenOff` fails the dark cases above.
    const c = reading()
    c.state.screenOff = false
    inner(c).onRelayUpsert(item({ kind: 'info', present: 'takeover-if-elsewhere', sessionId: 's1' }))
    expect(modeOf(c)).toBe('conversation')
  })
})

describe('an older server', () => {
  test('a question with no field set still takes the screen', () => {
    // `present` absent means a server from before it existed. The app keeps a
    // rule for that case, and it is the corrected one rather than the shipped
    // one - the old behaviour is the bug.
    const c = reading()
    inner(c).onRelayUpsert(item({ present: undefined, sessionId: 's1' }))
    expect(modeOf(c)).toBe('overlay')
  })

  test('a notice with no field set keeps yielding to its own session', () => {
    const c = reading()
    inner(c).onRelayUpsert(item({ kind: 'info', present: undefined, sessionId: 's1' }))
    expect(modeOf(c)).toBe('conversation')
  })
})

describe('reconnecting', () => {
  test('a decision pending in the snapshot is presented, not just listed', () => {
    // A reconnect is not a reason to show the wearer less than they would have
    // been shown a moment earlier.
    const c = reading()
    inner(c).onRelaySnapshot([item({ sessionId: 's1' })])
    expect(modeOf(c)).toBe('overlay')
    expect(c.state.overlayItemId).toBe('i1')
  })

  test('mid-utterance it waits, as a fresh one would', () => {
    const c = reading()
    c.state.mode = 'voice'
    inner(c).onRelaySnapshot([item()])
    expect(modeOf(c)).toBe('voice')
  })
})
