// Following a question that moves.
//
// One AskUserQuestion call can hold several questions. The pane takes the
// answer to the first and draws the second without ever leaving `blocked`, so
// nothing the app watches changes state: the picker is dismissed on the Enter
// that answered question one, and questions two and three are left on a screen
// nobody is looking at.
//
// The server now replaces the waiting item when the question under a
// still-blocked pane changes (`refreshBlocked`). This is the other half: the
// wearer who is mid-answer gets taken to the next question rather than handed
// a notice about it.
//
// The failure it prevents is the quiet one. A picker still showing question
// one while the pane has moved to question two sends its Enter to question
// two — an answer to something the wearer never saw, which looks exactly like
// it worked.

import { describe, expect, test } from 'bun:test'
import { CHOICE_FOLLOW_MS, GlassesController } from '../controller.ts'
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
  enterChoice(options: string[], target: { sessionId: string; paneId?: string; itemId?: string }): void
  choiceFollowUntil: number
  choiceTarget: { sessionId: string; paneId?: string; itemId?: string } | null
}

const inner = (c: GlassesController) => c as unknown as Internals

function waiting(over: Partial<GlassesRelayItem> = {}): GlassesRelayItem {
  return {
    id: 'q2',
    kind: 'waiting',
    source: 'auto',
    sessionId: 's1',
    paneId: '%0',
    text: 'And how should the tests be split?',
    choices: ['One file per module', 'One file for the lot'],
    createdAt: 2,
    ...over,
  } as GlassesRelayItem
}

/** In the picker for question one, on pane %0 of s1. */
function inPicker(): GlassesController {
  const c = new GlassesController(platform())
  c.state.sessions = [{ id: 's1', name: 'ws', state: 'idle' }] as GlassesController['state']['sessions']
  inner(c).enterChoice(['Rewrite it', 'Patch minimally'], { sessionId: 's1', paneId: '%0', itemId: 'q1' })
  return c
}

/** Just answered it: the app dropped to the conversation and the follow window
 *  is open, which is the state the Enter in `onChoiceAction` leaves behind. */
function justAnswered(): GlassesController {
  const c = inPicker()
  c.state.mode = 'conversation'
  inner(c).choiceFollowUntil = Date.now() + CHOICE_FOLLOW_MS
  return c
}

describe('the next question of a multi-step ask', () => {
  test('takes the screen after the previous one was answered', () => {
    const c = justAnswered()
    inner(c).onRelayUpsert(waiting())
    expect(c.state.mode).toBe('choice')
    expect(c.state.choiceOptions).toEqual(['One file per module', 'One file for the lot'])
    expect(inner(c).choiceTarget?.itemId).toBe('q2')
  })

  test('replaces the options under a picker that is still open', () => {
    // The pane redrew without the wearer answering anything - a question
    // answered on the PC, or an ask that timed out. Every gesture from here
    // was going to land on a question that is no longer there.
    const c = inPicker()
    inner(c).onRelayUpsert(waiting())
    expect(c.state.mode).toBe('choice')
    expect(c.state.choiceOptions).toEqual(['One file per module', 'One file for the lot'])
  })

  test('the cursor starts at the top of the new question', () => {
    const c = inPicker()
    c.state.choiceIndex = 1
    inner(c).onRelayUpsert(waiting())
    expect(c.state.choiceIndex).toBe(0)
  })
})

describe('what it declines to follow', () => {
  test('another pane of the same workspace', () => {
    const c = justAnswered()
    inner(c).onRelayUpsert(waiting({ paneId: '%1' }))
    expect(c.state.mode).toBe('conversation')
  })

  test('another workspace', () => {
    const c = justAnswered()
    inner(c).onRelayUpsert(waiting({ sessionId: 's2' }))
    expect(c.state.mode).toBe('conversation')
  })

  test('the same item restated', () => {
    const c = justAnswered()
    inner(c).onRelayUpsert(waiting({ id: 'q1' }))
    expect(c.state.mode).toBe('conversation')
  })

  test('an item with nothing to pick', () => {
    const c = justAnswered()
    inner(c).onRelayUpsert(waiting({ choices: undefined }))
    expect(c.state.mode).toBe('conversation')
  })

  test('a question that arrives long after the answer', () => {
    // Past the window it is a new decision, and gets a notice like any other.
    const c = justAnswered()
    inner(c).choiceFollowUntil = Date.now() - 1
    inner(c).onRelayUpsert(waiting())
    expect(c.state.mode).toBe('conversation')
  })

  test('a picker the wearer closed', () => {
    // Double-tap out of the picker answers nothing, so nothing follows: a
    // screen that reopened itself would be the app overruling the gesture.
    const c = inPicker()
    c.doubleTap()
    inner(c).onRelayUpsert(waiting())
    expect(c.state.mode).toBe('conversation')
  })

  test('anything at all, in the demo', () => {
    // There is no pane behind the demo's picker to follow.
    const c = new GlassesController(platform())
    c.startDemo()
    inner(c).enterChoice(['a', 'b'], { sessionId: 'demo-open', paneId: '%0', itemId: 'q1' })
    inner(c).onRelayUpsert(waiting({ sessionId: 'demo-open' }))
    expect(c.state.choiceOptions).toEqual(['a', 'b'])
  })
})
