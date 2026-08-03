// What the header bar gives up first.
//
// The clock used to always survive and the title was clipped to make room.
// Adding the date turned that from a rounding error into a real cost — the
// right-hand side went from 52px to 173px, so a workspace name that fitted
// yesterday loses ten characters today. And the trade is the wrong way round:
// the title says which session is being read, which is the question; the date
// answers one that is usually not being asked.

import { describe, expect, test } from 'bun:test'
import { HEADER_WIDTH, textWidth } from '../metrics.ts'
import { screenText } from '../display.ts'
import type { AppState } from '../display.ts'

const DATE = /\d{4}-\d{2}-\d{2}/
const TIME = /\d{2}:\d{2}/

function conversationWith(name: string): string {
  const state = {
    mode: 'conversation',
    sessions: [{ id: 'w1', name, panes: [], indicatorState: 'idle' }],
    sessionIndex: 0,
    conversation: [{ role: 'assistant', text: 'hello' }],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceOptions: [],
    choiceIndex: 0,
    relayWaiting: [],
    relayInfo: [],
  } as unknown as AppState
  return screenText(state).header
}

describe('the header clock', () => {
  test('a short title keeps the date and the time', () => {
    const header = conversationWith('api')
    expect(header).toMatch(DATE)
    expect(header).toMatch(TIME)
  })

  test('a long title keeps the time and drops the date', () => {
    // Long enough that the date will not fit beside it, short enough that the
    // time still will.
    // 40 chars is 441px: past the 401px a date and time leave, inside the 520px
    // the time alone leaves.
    const header = conversationWith('a'.repeat(40))
    expect(header).not.toMatch(DATE)
    expect(header).toMatch(TIME)
    expect(header).toContain('aaaaaaaaaa')
  })

  test('a title that fills the bar keeps neither', () => {
    const header = conversationWith('b'.repeat(200))
    expect(header).not.toMatch(DATE)
    expect(header).not.toMatch(TIME)
    expect(header).toContain('bbbbbbbbbb')
  })

  test('the bar never overflows, whatever the title', () => {
    for (const name of ['x', 'x'.repeat(40), 'x'.repeat(100), 'あ'.repeat(40)]) {
      expect(textWidth(conversationWith(name))).toBeLessThanOrEqual(HEADER_WIDTH)
    }
  })

  test('a long title is clipped rather than wrapped', () => {
    // The bar is 28px of inner height against a 27px line: a second line is
    // not clipped, it is gone, and the clock with it.
    expect(conversationWith('c'.repeat(300))).not.toContain('\n')
  })
})
