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
import { CHOICE_SEND, choiceRows, looksMultiSelect, onChoiceSend, screenText, updateDisplay } from '../display.ts'
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

  test("a tick the firmware has no glyph for is substituted, not sent raw", () => {
    // Claude Code writes U+2714 and kimi U+2713. The panel carries neither, so
    // unsubstituted they arrive as tofu — while this window, drawing from a
    // browser font, shows them perfectly. The one row a wearer reads to know
    // what they have ticked is the worst place for that divergence.
    const body = screenText(st(['[✔] Apple', '[✓] Banana', '[ ] Cherry'])).body
    expect(body).toContain('[○] Apple')
    expect(body).toContain('[○] Banana')
    expect(body).toContain('[ ] Cherry')
  })

  test('the checkboxes the pane drew survive to the panel', () => {
    // They arrive through the relay scrape, which never stripped non-ASCII —
    // and now neither does the glasses-side one.
    const body = screenText(st(MULTI)).body
    expect(body).toContain('[x] 日本円でも表示')
    expect(body).toContain(CHOICE_SEND)
  })
})

describe('what the device draws', () => {
  // The panel the wearer sees is built by `buildChoice`, not by `screenText` —
  // the second is the copyable transcript of the first. `buildChoice` held the
  // single-pick footer as a constant, so on the device the multi-select
  // promised "tap:confirm" over the one screen where a tap does not confirm.
  // The simulator, drawing the same containers, was wrong in the same way.

  async function drawnFooter(state: AppState): Promise<string> {
    const contents: string[] = []
    const bridge = {
      textContainerUpgrade: () => Promise.resolve(),
      rebuildPageContainer: (c: { textObject: Array<{ content: string }> }) => {
        contents.push(...c.textObject.map((t) => t.content))
        return Promise.resolve(true)
      },
    }
    // A mode change is what forces the rebuild this reads.
    await updateDisplay(bridge as never, { ...state, mode: 'session_list' } as AppState)
    await updateDisplay(bridge as never, state)
    return contents[contents.length - 1]
  }

  test('the multi-select footer reaches the panel, not just the transcript', async () => {
    expect(await drawnFooter(st(MULTI))).toBe(screenText(st(MULTI)).footer)
  })

  test('a single pick still gets its own', async () => {
    expect(await drawnFooter(st(SINGLE))).toBe('swipe:select  tap:confirm  dbl:skip')
  })
})
