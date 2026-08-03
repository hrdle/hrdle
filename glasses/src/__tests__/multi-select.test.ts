// Answering a multi-select from the ring.
//
// Claude Code's multi-select answers to space-then-enter. The ring had no way
// to send a space, so a tap sent Enter over an empty set and the question came
// back unanswered — the picker looked like it worked and did nothing.
//
// Three verbs are needed where a single pick needs two: check, send, leave.
// There are four gestures and double-tap is spoken for — it means "leave" on
// every screen in this app, and a picker where it meant "send" instead would
// be the one place the wearer has to remember something. So the third verb is
// a row.

import { describe, expect, test } from 'bun:test'
import { CHOICE_SEND, choiceRows, looksMultiSelect, onChoiceSend, screenText } from '../display.ts'
import type { AppState } from '../display.ts'

function st(options: string[], index = 0): AppState {
  return {
    mode: 'choice',
    sessions: [],
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceOptions: options,
    choiceIndex: index,
    choiceMulti: looksMultiSelect(options),
    choiceSessionName: 'dashboard',
    relayWaiting: [],
    relayInfo: [],
  } as unknown as AppState
}

const MULTI = ['[ ] タップで日付と金額 (推奨)', '[ ] 各バーに金額を常時表示', '[x] 日本円でも表示']
const SINGLE = ['Postgres (Recommended)', 'SQLite', 'Ask me again later']

describe('detecting a multi-select', () => {
  test('a checkbox is enough', () => {
    expect(looksMultiSelect(MULTI)).toBe(true)
  })

  test('a single-pick list has none', () => {
    expect(looksMultiSelect(SINGLE)).toBe(false)
  })
})

describe('the send row', () => {
  test('is appended to a multi-select and counts what is checked', () => {
    const rows = choiceRows(st(MULTI))
    expect(rows).toHaveLength(MULTI.length + 1)
    expect(rows[rows.length - 1]).toBe(`${CHOICE_SEND} (1)`)
  })

  test('carries no count when nothing is checked yet', () => {
    const rows = choiceRows(st(['[ ] one', '[ ] two']))
    expect(rows[rows.length - 1]).toBe(CHOICE_SEND)
  })

  test('is absent from a single-pick list, which sends from any row', () => {
    expect(choiceRows(st(SINGLE))).toEqual(SINGLE)
  })

  test('is where the cursor is only past the last option', () => {
    expect(onChoiceSend(st(MULTI, MULTI.length - 1))).toBe(false)
    expect(onChoiceSend(st(MULTI, MULTI.length))).toBe(true)
    // A single-pick list has no send row to land on.
    expect(onChoiceSend(st(SINGLE, SINGLE.length))).toBe(false)
  })
})

describe('what the panel says', () => {
  test('the footer promises the gesture that never changes', () => {
    // `tap` does one of two things depending on the row, so the row says which
    // and the footer says the one that is always true.
    expect(screenText(st(MULTI)).footer).toContain('dbl:cancel')
    expect(screenText(st(MULTI)).footer).toContain('tap:check/send')
  })

  test('a single pick keeps the wording it had', () => {
    expect(screenText(st(SINGLE)).footer).toBe('swipe:select  tap:confirm  dbl:skip')
  })

  test('the checkboxes the pane drew survive to the panel', () => {
    // They arrive through the relay scrape, which never stripped non-ASCII —
    // and now neither does the glasses-side one.
    const body = screenText(st(MULTI)).body
    expect(body).toContain('[x] 日本円でも表示')
    expect(body).toContain(CHOICE_SEND)
  })
})
