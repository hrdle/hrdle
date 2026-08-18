// The two marks a row can carry, and what each of them is allowed to mean.
//
// Both are here because a mark that means two things is worse than no mark.
// The arrow used to mean "this row does something" *and* "the cursor is here",
// so every screen opened with an arrow on a row nobody had chosen; the status
// column has to be a fixed width, or a list ripples sideways as agents start
// and stop.

import { describe, expect, test } from 'bun:test'
import { BADGE_BLANK, DIRECT_ROW, askRows, initialState, screenText, somethingIsWorking } from '../display.ts'
import type { AppState } from '../display.ts'
import { textWidth } from '../metrics.ts'
import type { Session, StewardThreadItem } from '../types.ts'

;(globalThis as unknown as { __PRODUCT_NAME__: string }).__PRODUCT_NAME__ = 'Hrdle'

function state(over: Partial<AppState> = {}): AppState {
  return { ...initialState(), connected: true, ...over }
}

function sessions(...names: string[]): Session[] {
  return names.map((name, i) => ({ id: `w${i + 1}`, name }))
}

function working(): Session[] {
  return [
    {
      id: 'w1',
      name: 'work-1',
      panes: [{ paneId: '%1', isActive: true, agent: 'claude', indicatorState: 'processing' }],
    },
    { id: 'w2', name: 'work-2' },
  ]
}

function ask(mode: 'single' | 'multi' | 'freeText', choices: string[]): StewardThreadItem {
  return { id: 'a1', at: 1, role: 'steward', kind: 'ask', text: 'Send it?', ask: { id: 'a1', mode, choices } }
}

/** Every arrow anywhere on the screen, whatever it is doing there. */
function arrows(s: AppState): number {
  const t = screenText(s)
  return [t.header, t.notice ?? '', t.body, t.footer].join('\n').split(/[>→]/).length - 1
}

describe('the arrow', () => {
  // The complaint this fixes: the session screen opened on its newest page with
  // `→ Talk to this session directly` at the bottom - the only arrow on the
  // panel, on the one row that was not selected.
  test('a screen at rest carries exactly one, and it is the cursor', () => {
    const withTurn = state({ sessions: sessions('work-1'), openSessionId: 'w1' })
    withTurn.turns.set('w1', [{ id: 't1', at: 1, role: 'steward', text: 'Seven comments came back.' }])

    expect(arrows(state({ sessions: sessions('work-1', 'work-2') }))).toBe(1) // overview: the cursor
    expect(arrows({ ...withTurn, screen: 'session' })).toBe(0) // session: pages have no cursor
    expect(arrows({ ...state({ sessions: sessions('work-1') }), screen: 'ask', ask: ask('multi', ['a', 'b']) })).toBe(1)
    expect(arrows({ ...state({ sessions: sessions('work-1') }), screen: 'ask', ask: ask('freeText', []) })).toBe(1)
  })

  test('the action rows keep their words and lose the mark', () => {
    const body = screenText(state({ sessions: sessions('work-1') })).body
    expect(body).toContain('Talk to the steward')
    expect(body).not.toContain('→')
    expect(DIRECT_ROW).toBe('Talk to this session directly')
    const multi = ask('multi', ['a', 'b'])
    if (multi.kind !== 'ask') throw new Error('fixture')
    expect(askRows(multi.ask).some((r) => r.kind === 'send')).toBe(true)
  })

  // The cursor moves on every swipe, so a column that is not the same width
  // marked and unmarked makes the whole list shiver sideways as it is walked.
  test('costs the same width whether it is drawn or not', () => {
    const lines = screenText(state({ sessions: sessions('work-1', 'work-2') })).body.split('\n')
    const marked = lines.find((l) => l.includes('work-1')) as string
    const unmarked = lines.find((l) => l.includes('work-2')) as string
    expect(textWidth(marked.slice(0, marked.indexOf('work-1')))).toBe(
      textWidth(unmarked.slice(0, unmarked.indexOf('work-2'))),
    )
  })
})

describe('the working indicator', () => {
  test('a working session is marked and an idle one is not', () => {
    const body = screenText(state({ sessions: working() })).body
    const marked = body.split('\n').find((l) => l.includes('work-1')) as string
    const plain = body.split('\n').find((l) => l.includes('work-2')) as string
    expect(marked).toContain('·')
    expect(plain).toContain(BADGE_BLANK)
    expect(plain).not.toContain('·')
  })

  test('it blinks: the frame follows the tick', () => {
    const at = (tick: number) => screenText(state({ sessions: working(), spinnerTick: tick })).body
    expect(at(0)).toContain('·')
    expect(at(1)).toContain('•')
    expect(at(2)).toContain('·')
  })

  // 80 and 144 units against 320 for the blank - the whole reason to use them.
  // Left unpadded, every working row's name starts a third of a column left of
  // every other one.
  test('the column is one width, so names do not move as agents start and stop', () => {
    const column = (s: AppState) => {
      const line = screenText(s).body.split('\n').find((l) => l.includes('work-1')) as string
      return textWidth(line.slice(0, line.indexOf('work-1')))
    }
    const idle = column(state({ sessions: sessions('work-1') }))
    for (const tick of [0, 1]) {
      // Within a pixel: the dots are 5 and 9 units against a 5-unit space, so
      // the pad lands within one of the column rather than on it.
      expect(Math.abs(column(state({ sessions: working(), spinnerTick: tick })) - idle)).toBeLessThanOrEqual(1)
    }
  })

  test('the direct screen says it too, and waiting still outranks it', () => {
    const s = state({ screen: 'direct', sessions: working(), openSessionId: 'w1', spinnerTick: 1 })
    expect(screenText(s).header).toContain('•')

    const waiting = working()
    waiting[0].panes = [{ paneId: '%1', isActive: true, agent: 'claude', indicatorState: 'waiting_input' }]
    expect(screenText({ ...s, sessions: waiting }).header).toContain('[!]')
  })

  // An idle app sends nothing: each frame is a BLE round trip, and there is no
  // point spending one to redraw a panel that has no indicator on it.
  test('nothing is redrawn when nothing is working', () => {
    expect(somethingIsWorking(state({ sessions: working() }))).toBe(true)
    expect(somethingIsWorking(state({ sessions: sessions('work-1') }))).toBe(false)
    // The session screen shows no indicator, so a tick there would redraw for
    // nothing.
    expect(somethingIsWorking(state({ screen: 'session', sessions: working(), openSessionId: 'w1' }))).toBe(false)
    expect(somethingIsWorking(state({ screen: 'direct', sessions: working(), openSessionId: 'w1' }))).toBe(true)
  })
})
