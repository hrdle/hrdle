// What a gesture means on each screen, and where a spoken sentence goes.
//
// The routing is the part worth holding: the screen a sentence was started
// from is the whole of its addressing, so a wrong transition is a sentence
// delivered somewhere the wearer did not choose - and nothing on the panel
// would say so.

import { describe, expect, mock, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import type { Session, StewardSessionLine, StewardThreadItem } from '../types.ts'

;(globalThis as unknown as { __PRODUCT_NAME__: string }).__PRODUCT_NAME__ = 'Hrdle'
;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.1'
;(globalThis as unknown as { __BUILD_COMMIT__: string }).__BUILD_COMMIT__ = 'test'

function platform(over: Partial<GlassesPlatform> = {}): GlassesPlatform {
  return {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() {
      return true
    },
    async stopMicCapture() {},
    async transcribeAudio() {
      return 'spoken'
    },
    ...over,
  }
}

/** The controller with its socket never connected: every test here drives it
 *  through the same handlers the socket would call. */
function controller(over: Partial<GlassesPlatform> = {}): GlassesController {
  return new GlassesController(platform(over))
}

type Internals = {
  onSessions(sessions: Session[]): void
  onSnapshot(thread: StewardThreadItem[], lines: StewardSessionLine[]): void
  onThreadItem(item: StewardThreadItem): void
  deliver(target: unknown, text: string): Promise<void>
}
const inner = (c: GlassesController) => c as unknown as Internals

function sessions(...names: string[]): Session[] {
  return names.map((name, i) => ({ id: `w${i + 1}`, name, panes: [{ paneId: '%1', isActive: true }] }))
}

function askItem(over: Partial<{ id: string; mode: 'single' | 'multi' | 'freeText'; choices: string[]; sessionId: string }> = {}): StewardThreadItem {
  const id = over.id ?? 'a1'
  return {
    id,
    at: 1,
    role: 'steward',
    kind: 'ask',
    text: 'Send it?',
    sessionId: over.sessionId,
    ask: { id, mode: over.mode ?? 'single', choices: over.choices ?? ['yes', 'no'] },
  }
}

function loaded(over: Partial<GlassesPlatform> = {}): GlassesController {
  const c = controller(over)
  inner(c).onSessions(sessions('work-1', 'work-2'))
  return c
}

describe('the list', () => {
  test('a tap on a session opens it', () => {
    const c = loaded()
    c.tap()
    expect(c.state.screen).toBe('session')
    expect(c.state.openSessionId).toBe('w1')
  })

  test('the last row is the steward, and it opens the microphone', () => {
    const c = loaded()
    c.swipeDown()
    c.swipeDown()
    c.tap()
    expect(c.state.screen).toBe('voice')
    expect(c.state.voice?.target).toEqual({ kind: 'steward' })
  })

  // Fixed by the Hub's review requirements, and the one gesture in this app
  // that does not mean "go back".
  test('a double tap asks the host to close the app', () => {
    const exit = mock(() => {})
    const c = loaded({ requestExit: exit })
    c.doubleTap()
    expect(exit).toHaveBeenCalled()
    expect(c.state.screen).toBe('overview')
  })

  test('the cursor cannot leave the rows', () => {
    const c = loaded()
    c.swipeUp()
    expect(c.state.cursor).toBe(0)
    for (let i = 0; i < 20; i++) c.swipeDown()
    expect(c.state.cursor).toBe(2) // two sessions and the steward row
  })
})

describe('a session', () => {
  test('a tap speaks to the steward about that session', () => {
    const c = loaded()
    c.tap()
    c.tap()
    expect(c.state.screen).toBe('voice')
    expect(c.state.voice?.target).toEqual({ kind: 'steward-session', sessionId: 'w1' })
  })

  // One swipe from where the screen opens, and never landed on while paging
  // back through history.
  test('swiping past the newest page selects the direct row', () => {
    const c = loaded()
    c.tap()
    expect(c.state.sessionPage).toBe(0)
    c.swipeUp()
    expect(c.state.sessionPage).toBe(-1)
    c.tap()
    expect(c.state.screen).toBe('direct')
  })

  test('a double tap goes back to the list and drops the pane subscription', () => {
    const c = loaded()
    c.tap()
    c.doubleTap()
    expect(c.state.screen).toBe('overview')
    expect(c.state.openSessionId).toBeNull()
  })
})

describe('direct mode', () => {
  test('a tap speaks to the pane, and a double tap comes back up one step', () => {
    const c = loaded()
    c.tap()
    c.swipeUp()
    c.tap()
    expect(c.state.screen).toBe('direct')
    c.tap()
    expect(c.state.voice?.target).toEqual({ kind: 'pane', sessionId: 'w1' })
    c.doubleTap() // cancel the microphone
    expect(c.state.screen).toBe('direct')
    c.doubleTap()
    expect(c.state.screen).toBe('session')
  })
})

describe('a question interrupts, except when it must not', () => {
  test('it takes the screen from the list', () => {
    const c = loaded()
    inner(c).onThreadItem(askItem())
    expect(c.state.screen).toBe('ask')
  })

  // Speaking to a screen that changes under you sends the sentence somewhere
  // you did not choose.
  test('it waits while the wearer is speaking', () => {
    const c = loaded()
    c.swipeDown()
    c.swipeDown()
    c.tap()
    expect(c.state.screen).toBe('voice')
    inner(c).onThreadItem(askItem())
    expect(c.state.screen).toBe('voice')
    expect(c.state.deferredAskId).toBe('a1')
  })

  test('it waits while the wearer is one step down in a session', () => {
    const c = loaded()
    c.tap()
    c.swipeUp()
    c.tap()
    expect(c.state.screen).toBe('direct')
    inner(c).onThreadItem(askItem())
    expect(c.state.screen).toBe('direct')
    expect(c.state.deferredAskId).toBe('a1')
  })

  test('and is shown the moment they come back up', () => {
    const c = loaded()
    c.tap()
    c.swipeUp()
    c.tap()
    inner(c).onThreadItem(askItem())
    c.doubleTap() // up out of direct mode
    expect(c.state.screen).toBe('ask')
    expect(c.state.deferredAskId).toBeNull()
  })

  test('one answered elsewhere leaves the screen rather than waiting for an answer', () => {
    const c = loaded()
    const item = askItem()
    inner(c).onThreadItem(item)
    expect(c.state.screen).toBe('ask')
    inner(c).onThreadItem({
      ...item,
      kind: 'ask',
      ask: { id: 'a1', mode: 'single', choices: ['yes', 'no'], answer: { kind: 'choice', indices: [0] } },
    } as StewardThreadItem)
    expect(c.state.screen).not.toBe('ask')
  })
})

describe('answering', () => {
  /** What `replyToSteward` would have been called with. */
  function captureAnswers(c: GlassesController): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = []
    ;(c as unknown as { answerAsk(answer: unknown): Promise<void> }).answerAsk = async (answer) => {
      sent.push({ answer })
      ;(c as unknown as { leaveAsk(): void }).leaveAsk()
    }
    return sent
  }

  test('a single pick sends that index', () => {
    const c = loaded()
    const sent = captureAnswers(c)
    inner(c).onThreadItem(askItem())
    c.swipeDown()
    c.tap()
    expect(sent[0]?.answer).toEqual({ kind: 'choice', indices: [1] })
  })

  test('a multi-select ticks on tap and sends from its own row', () => {
    const c = loaded()
    const sent = captureAnswers(c)
    inner(c).onThreadItem(askItem({ mode: 'multi', choices: ['a', 'b'] }))
    c.tap() // tick a
    expect(c.state.askChecked).toEqual([0])
    expect(sent).toHaveLength(0)
    c.swipeDown()
    c.swipeDown() // onto Send
    c.tap()
    expect(sent[0]?.answer).toEqual({ kind: 'choice', indices: [0] })
  })

  // Ticking nothing is a decision, and the one the steward can act on where
  // silence is one it waits out.
  test('the send row sends an empty set', () => {
    const c = loaded()
    const sent = captureAnswers(c)
    inner(c).onThreadItem(askItem({ mode: 'multi', choices: ['a', 'b'] }))
    c.swipeDown()
    c.swipeDown()
    c.tap()
    expect(sent[0]?.answer).toEqual({ kind: 'choice', indices: [] })
  })

  // The server refuses a choice against a free-text question, and rightly:
  // what it asked for is words.
  test('a listed choice on a free-text question is sent as those words', () => {
    const c = loaded()
    const sent = captureAnswers(c)
    inner(c).onThreadItem(askItem({ mode: 'freeText', choices: ['carry on'] }))
    c.tap()
    expect(sent[0]?.answer).toEqual({ kind: 'text', text: 'carry on' })
  })

  test('its own row opens the microphone against that question', () => {
    const c = loaded()
    inner(c).onThreadItem(askItem({ mode: 'freeText', choices: ['carry on'], sessionId: 'w1' }))
    c.swipeDown()
    c.tap()
    expect(c.state.screen).toBe('voice')
    expect(c.state.voice?.target).toEqual({ kind: 'ask', askId: 'a1', sessionId: 'w1' })
  })

  // Without it the steward waits forever on a question nobody intends to
  // answer.
  test('a double tap is an answer of its own', () => {
    const c = loaded()
    const sent = captureAnswers(c)
    inner(c).onThreadItem(askItem())
    c.doubleTap()
    expect(sent[0]?.answer).toEqual({ kind: 'dismissed' })
  })

  test('answering returns to the session the question was about', () => {
    const c = loaded()
    captureAnswers(c)
    inner(c).onThreadItem(askItem({ sessionId: 'w2' }))
    c.tap()
    expect(c.state.screen).toBe('session')
    expect(c.state.openSessionId).toBe('w2')
  })
})

describe('the report', () => {
  const report: StewardThreadItem = {
    id: 'r1',
    at: 1,
    role: 'steward',
    kind: 'report',
    text: '2 sessions are stuck',
    rows: ['work-2  waiting  12m', 'something unmatched  4m'],
  }

  test('is reached from its row on the list, and opens a session from a row', () => {
    const c = loaded()
    inner(c).onSnapshot([report], [])
    c.swipeDown()
    c.swipeDown() // onto the report row
    c.tap()
    expect(c.state.screen).toBe('report')
    c.tap()
    expect(c.state.screen).toBe('session')
    expect(c.state.openSessionId).toBe('w2')
  })

  // Opening the wrong session would be worse than opening none, and refusing
  // to draw the row would hide what the steward reported.
  test('a row that matches no session simply does not open one', () => {
    const c = loaded()
    inner(c).onSnapshot([report], [])
    c.swipeDown()
    c.swipeDown()
    c.tap()
    c.swipeDown() // the unmatched row
    c.tap()
    expect(c.state.screen).toBe('report')
  })
})
