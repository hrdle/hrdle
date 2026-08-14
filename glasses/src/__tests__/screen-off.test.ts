// The panel goes dark after three minutes with nobody at the ring, because
// nothing else puts it out: a screen drawn once and forgotten stays lit.
//
// The rules under test:
//
// - a single touch on a dark screen does NOTHING (an accidental brush against
//   the ring is a single touch; while dark, it is spent on nothing at all)
// - the double-tap relights, and is consumed doing so - it must not reach the
//   host's root exit dialogue
// - an item taking the screen relights it: a notification delivered to a black
//   panel was never delivered

import { describe, expect, test } from 'bun:test'
import { GlassesController, screenOffMsFrom } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import { screenText } from '../display.ts'
import type { GlassesRelayItem } from '../types.ts'

function platform(counts: { exits: number }): GlassesPlatform {
  return {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {
      counts.exits++
    },
    async startMicCapture() { return true },
    async stopMicCapture() {},
    async transcribeAudio() { throw new Error('not used here') },
  } as unknown as GlassesPlatform
}

type Internals = {
  lastGestureAt: number
  lastActivityAt: number
  recording: boolean
  screenOffIdleMs: number
  tickScreenOff(): void
  onRelayUpsert(item: GlassesRelayItem): void
}

const inner = (c: GlassesController) => c as unknown as Internals

/** The timeout the tests run with. Auto-off ships disabled (0), so every
 *  controller here opts in the way a wearer would - via the setting. */
const TEST_IDLE_MS = 3 * 60_000

function controller(mode: 'session_list' | 'conversation' | 'overlay' | 'voice' | 'choice') {
  const counts = { exits: 0 }
  const c = new GlassesController(platform(counts))
  inner(c).screenOffIdleMs = TEST_IDLE_MS
  c.state.sessions = [
    { id: 's1', name: 'one', state: 'idle' },
  ] as GlassesController['state']['sessions']
  c.state.sessionIndex = 0
  c.state.mode = mode
  return { c, counts }
}

/** Age both clocks past the deadline, as three quiet minutes would. */
function ageOut(c: GlassesController): void {
  inner(c).lastGestureAt = Date.now() - TEST_IDLE_MS - 1
  inner(c).lastActivityAt = Date.now() - TEST_IDLE_MS - 1
}

describe('going dark', () => {
  test('a read screen left alone past the deadline goes dark, and quotes as nothing', () => {
    for (const mode of ['session_list', 'conversation', 'overlay'] as const) {
      const { c } = controller(mode)
      ageOut(c)
      inner(c).tickScreenOff()
      expect(c.state.screenOff).toBe(true)
      // The screen underneath is kept, not replaced.
      expect(c.state.mode).toBe(mode)
      const quoted = screenText(c.state)
      expect(quoted.header).toBe('')
      expect(quoted.body).toBe('')
      expect(quoted.footer).toBe('')
    }
  })

  test('before the deadline nothing happens', () => {
    const { c } = controller('session_list')
    inner(c).lastGestureAt = Date.now() - 1000
    inner(c).lastActivityAt = Date.now() - 1000
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBeUndefined()
  })

  test('mid-input screens never sleep: the panel IS the input there', () => {
    for (const mode of ['voice', 'choice'] as const) {
      const { c } = controller(mode)
      ageOut(c)
      inner(c).tickScreenOff()
      expect(c.state.screenOff).toBeUndefined()
    }
  })

  test('the demo never sleeps: its root double-tap belongs to the exit dialogue', () => {
    const { c } = controller('session_list')
    c.startDemo()
    ageOut(c)
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBeUndefined()
  })

  test('a timeout of zero means the panel never sleeps', () => {
    // `0` is the settings screen's "never" - the server hands it over in
    // minutes and the controller keeps it as a disabled clock.
    const { c } = controller('session_list')
    inner(c).screenOffIdleMs = 0
    ageOut(c)
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBeUndefined()
  })

  test('a shorter server-set timeout is honoured', () => {
    const { c } = controller('session_list')
    inner(c).screenOffIdleMs = 60_000
    inner(c).lastGestureAt = Date.now() - 61_000
    inner(c).lastActivityAt = Date.now() - 61_000
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBe(true)
  })

  test('an item that recently took the screen holds the deadline off', () => {
    // The gesture clock is stale but the activity clock is not - a question
    // that arrived moments ago must not be blanked before anyone could look.
    const { c } = controller('overlay')
    inner(c).lastGestureAt = Date.now() - TEST_IDLE_MS - 1
    inner(c).lastActivityAt = Date.now() - 1000
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBeUndefined()
  })
})

describe('the ring against a dark panel', () => {
  test('a single tap or swipe does nothing at all', () => {
    const { c } = controller('conversation')
    ageOut(c)
    inner(c).tickScreenOff()
    c.tap()
    c.swipeUp()
    c.swipeDown()
    expect(c.state.screenOff).toBe(true)
    expect(c.state.mode).toBe('conversation')
  })

  test('a double-tap relights the same screen, and never reaches the exit dialogue', () => {
    const { c, counts } = controller('session_list')
    ageOut(c)
    inner(c).tickScreenOff()
    c.doubleTap()
    expect(c.state.screenOff).toBe(false)
    expect(c.state.mode).toBe('session_list')
    // On the lit list the same gesture asks the host to leave; while waking it
    // must be spent on waking.
    expect(counts.exits).toBe(0)
  })
})

describe('what relights the panel on its own', () => {
  test('a question taking the screen wakes it', () => {
    const { c } = controller('conversation')
    ageOut(c)
    inner(c).tickScreenOff()
    inner(c).onRelayUpsert({
      id: 'i1',
      kind: 'waiting',
      source: 'auto',
      sessionId: 's1',
      paneId: '%0',
      text: 'Which migration?',
      present: 'takeover',
      createdAt: 1,
    } as GlassesRelayItem)
    expect(c.state.screenOff).toBe(false)
    expect(c.state.mode).toBe('overlay')
  })

  test('a banner-grade item leaves it dark', () => {
    const { c } = controller('conversation')
    ageOut(c)
    inner(c).tickScreenOff()
    inner(c).onRelayUpsert({
      id: 'i2',
      kind: 'info',
      source: 'auto',
      sessionId: 's1',
      text: 'done',
      present: 'banner',
      createdAt: 1,
    } as GlassesRelayItem)
    expect(c.state.screenOff).toBe(true)
  })

  test('coming back to the foreground wakes it', () => {
    const { c } = controller('conversation')
    ageOut(c)
    inner(c).tickScreenOff()
    // The reconnect wants a `location`; a resume's waking is what is on trial.
    c.ws.connect = () => {}
    c.onForegroundEnter()
    expect(c.state.screenOff).toBe(false)
  })
})

/**
 * The compatibility direction that actually happens: the store hands out an app
 * newer than whatever server it is pointed at.
 */
describe('a server that does not know the setting', () => {
  test('a view without the field yields no timeout, so the built-in one stands', () => {
    expect(screenOffMsFrom({} as { screenOffSeconds?: number })).toBeNull()
    expect(screenOffMsFrom({ screenOffSeconds: Number.NaN })).toBeNull()
    expect(screenOffMsFrom({ screenOffSeconds: -1 })).toBeNull()
    expect(screenOffMsFrom({ screenOffSeconds: 0 })).toBe(0)
    expect(screenOffMsFrom({ screenOffSeconds: 180 })).toBe(180_000)
  })

  /** Why the guard is `Number.isFinite` rather than a truthiness check: NaN
   *  passes both of `tickScreenOff`'s tests, because every comparison against
   *  it is false. Nothing about the symptom points back at the setting. */
  test('NaN would have blanked the panel with no idle time at all', () => {
    const { c } = controller('conversation')
    inner(c).screenOffIdleMs = Number.NaN

    inner(c).lastGestureAt = Date.now()
    inner(c).lastActivityAt = Date.now()
    inner(c).tickScreenOff()

    expect(c.state.screenOff).toBe(true)
  })
})

describe('turning the timeout off', () => {
  test('relights a panel that is already dark', () => {
    const { c } = controller('conversation')
    ageOut(c)
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBe(true)

    inner(c).screenOffIdleMs = 0
    inner(c).tickScreenOff()

    expect(c.state.screenOff).toBe(false)
  })
})

describe('a dark panel and the takeover rule', () => {
  /**
   * `takeover-if-elsewhere` is every non-`waiting` item, and those come from
   * the `Stop` hook on every response. Relighting for the conversation already
   * being read means an agent working in bursts keeps the panel awake for good.
   */
  test('a completion notice for the session on screen does not relight it', () => {
    const { c } = controller('conversation')
    ageOut(c)
    inner(c).tickScreenOff()
    expect(c.state.screenOff).toBe(true)

    inner(c).onRelayUpsert({
      id: 'done-1',
      kind: 'info',
      source: 'auto',
      sessionId: 's1',
      text: 'Response complete',
      present: 'takeover-if-elsewhere',
    } as GlassesRelayItem)

    expect(c.state.screenOff).toBe(true)
  })

  test('but one for another session still does', () => {
    const { c } = controller('conversation')
    ageOut(c)
    inner(c).tickScreenOff()

    inner(c).onRelayUpsert({
      id: 'done-2',
      kind: 'info',
      source: 'auto',
      sessionId: 's2',
      text: 'Response complete',
      present: 'takeover-if-elsewhere',
    } as GlassesRelayItem)

    expect(c.state.screenOff).toBe(false)
  })
})
