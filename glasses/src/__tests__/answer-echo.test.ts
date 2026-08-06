// Saying what was sent.
//
// A scraped question belongs to the pane's blocked epoch, so the app does not
// take it down on an answer - the server does, once it sees the pane move.
// That is right, and it left the moment that matters silent: the ring sends
// the key, the same question sits on the strip for a beat, and then it goes
// without ever saying what went with it.
//
// Reported from the device on 2026-08-07, after a `うどん / そば` pick, as not
// being able to tell whether the selection had gone through. The recording
// agrees: tap, one more second of the question, then nothing.

import { describe, expect, test } from 'bun:test'
import { ANSWER_ECHO_MS, SENT_LABEL, screenText } from '../display.ts'
import type { AppState } from '../display.ts'
import { GlassesController } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import type { GlassesRelayItem } from '../types.ts'

function waiting(): GlassesRelayItem {
  return {
    id: 'q1',
    kind: 'waiting',
    source: 'auto',
    sessionId: 's1',
    paneId: '%0',
    text: '好きな麺はどれですか？',
    choices: ['うどん', 'そば'],
    createdAt: 1,
  } as GlassesRelayItem
}

function st(over: Partial<AppState> = {}): AppState {
  return {
    mode: 'conversation',
    sessions: [{ id: 's1', name: 'ws', state: 'idle' }],
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceOptions: [],
    choiceIndex: 0,
    relayWaiting: [waiting()],
    relayInfo: [],
    ...over,
  } as unknown as AppState
}

describe('the strip over an answer just sent', () => {
  test('says what went, not the question it answered', () => {
    const notice = screenText(st({ answered: { text: 'そば', until: Date.now() + 1000 } })).notice
    expect(notice).toContain(SENT_LABEL)
    expect(notice).toContain('そば')
    // The question is still queued - the server has not seen the pane move -
    // but for these seconds it is not the news.
    expect(notice).not.toContain('好きな麺はどれですか')
  })

  test('gives the queue back when it is over', () => {
    const notice = screenText(st({ answered: { text: 'そば', until: Date.now() - 1 } })).notice
    expect(notice).toContain('好きな麺はどれですか')
    expect(notice).not.toContain(SENT_LABEL)
  })

  test('is absent when nothing was answered', () => {
    expect(screenText(st()).notice).toContain('好きな麺はどれですか')
  })
})

describe('what a tap records', () => {
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
    enterChoice(options: string[], target: { sessionId: string; paneId?: string; itemId?: string }): void
    sendChoiceKey(data: string): void
    handle(action: 'tap'): Promise<void>
  }
  const inner = (c: GlassesController) => c as unknown as Internals

  test('a single pick echoes the option it sent', async () => {
    const c = new GlassesController(platform())
    c.state.sessions = [{ id: 's1', name: 'ws', state: 'idle' }] as GlassesController['state']['sessions']
    inner(c).sendChoiceKey = () => {}
    inner(c).enterChoice(['うどん', 'そば'], { sessionId: 's1', paneId: '%0', itemId: 'q1' })
    c.state.choiceIndex = 1
    await inner(c).handle('tap')
    expect(c.state.answered?.text).toBe('そば')
    expect(c.state.answered!.until).toBeGreaterThan(Date.now())
  })

  test('a multi-select echoes everything it ticked, not the row it sent from', async () => {
    const c = new GlassesController(platform())
    c.state.sessions = [{ id: 's1', name: 'ws', state: 'idle' }] as GlassesController['state']['sessions']
    inner(c).sendChoiceKey = () => {}
    inner(c).enterChoice(['[✔] うどん', '[ ] そば', '[✔] らーめん'], {
      sessionId: 's1', paneId: '%0', itemId: 'q1',
    })
    c.state.choiceIndex = 3 // the send row
    await inner(c).handle('tap')
    expect(c.state.answered?.text).toBe('うどん, らーめん')
  })

  test('the window is the one the strip reads', () => {
    expect(ANSWER_ECHO_MS).toBeGreaterThan(1000)
  })
})
