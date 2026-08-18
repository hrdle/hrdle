// What each screen is made of, at the panel's real width.
//
// These assert against `screenText` rather than against the containers: the
// wording and the layout are what a wearer meets, and the containers are how
// they get there. A page that runs past the panel's line budget is drawn
// clipped by the device, silently, so the budget is asserted too.

import { describe, expect, test } from 'bun:test'
import {
  askFooter,
  askRows,
  deferredNotice,
  initialState,
  overviewRows,
  screenText,
  sessionPageCount,
  sessionPages,
  windowStart,
  wrapForPanel,
} from '../display.ts'
import type { AppState } from '../display.ts'
import { BADGE_BLANK } from '../display.ts'
import { LIST_LINES, MAX_LINES } from '../metrics.ts'
import type { Session, StewardThreadItem, StewardTurn } from '../types.ts'

;(globalThis as unknown as { __PRODUCT_NAME__: string }).__PRODUCT_NAME__ = 'Hrdle'

function sessions(...names: string[]): Session[] {
  return names.map((name, i) => ({ id: `w${i + 1}`, name }))
}

function state(over: Partial<AppState> = {}): AppState {
  return { ...initialState(), connected: true, ...over }
}

function report(rows: string[]): StewardThreadItem {
  return {
    id: 'r1',
    at: 1,
    role: 'steward',
    kind: 'report',
    text: '3 sessions are stuck',
    rows,
  }
}

function ask(over: Partial<{ mode: 'single' | 'multi' | 'freeText'; choices: string[]; sessionId: string; step: { index: number; total: number } }> = {}): StewardThreadItem {
  return {
    id: 'a1',
    at: 1,
    role: 'steward',
    kind: 'ask',
    text: 'Send the review to Fable?',
    sessionId: over.sessionId,
    ask: {
      id: 'a1',
      mode: over.mode ?? 'single',
      choices: over.choices ?? ['Send it (recommended)', 'Write it myself'],
      step: over.step,
    },
  }
}

function turn(id: string, text: string, role: StewardTurn['role'] = 'steward'): StewardTurn {
  return { id, at: 1, role, text }
}

/** Lines a body actually occupies once the container has wrapped it. */
function bodyLines(text: string): number {
  return wrapForPanel(text).split('\n').length
}

describe('overview', () => {
  test('every session is on it, in the order the server gave them', () => {
    const s = state({ sessions: sessions('work-1', 'work-2', 'life') })
    const rows = overviewRows(s)
    expect(rows.filter((r) => r.kind === 'session').map((r) => (r.kind === 'session' ? r.session.name : '')))
      .toEqual(['work-1', 'work-2', 'life'])
  })

  // Dropping rows is what would make "what happened to that one" unanswerable,
  // which is most of what a list is for. Narrowing is the report screen's job.
  test('sessions the steward has written nothing about are still rows', () => {
    const s = state({
      sessions: sessions('work-1', 'work-2'),
      lines: [{ sessionId: 'w1', text: 'waiting on review 12m', at: 1 }],
    })
    const rows = overviewRows(s)
    expect(rows.filter((r) => r.kind === 'session')).toHaveLength(2)
    const body = screenText(s).body
    expect(body).toContain('work-2')
  })

  test('the steward row is always last, and the report row only when there is one', () => {
    const bare = overviewRows(state({ sessions: sessions('work-1') }))
    expect(bare.map((r) => r.kind)).toEqual(['session', 'say'])

    const withReport = overviewRows(state({ sessions: sessions('work-1'), thread: [report(['work-1  x'])] }))
    expect(withReport.map((r) => r.kind)).toEqual(['session', 'report', 'say'])
  })

  test('it has no header bar, and its rows fit the list container', () => {
    const s = state({ sessions: sessions(...Array.from({ length: 14 }, (_, i) => `work-${i + 1}`)) })
    const screen = screenText(s)
    expect(screen.headerless).toBe(true)
    expect(screen.body.split('\n').length).toBeLessThanOrEqual(LIST_LINES)
  })

  test('the cursor stays on screen as it moves past the window', () => {
    const total = 20
    expect(windowStart(0, total, LIST_LINES)).toBe(0)
    const start = windowStart(15, total, LIST_LINES)
    expect(15).toBeGreaterThanOrEqual(start)
    expect(15).toBeLessThan(start + LIST_LINES)
    // Never scrolled past the end.
    expect(windowStart(19, total, LIST_LINES)).toBe(total - LIST_LINES)
  })

  // A trailing mark reads as "there is more of this", and a wearer acts on
  // that. Drawn on a row that fits, it is the layout saying something untrue.
  test('a row that fits carries no cut mark', () => {
    const s = state({
      sessions: sessions('work-1'),
      lines: [{ sessionId: 'w1', text: 'waiting on review 12m', at: 1 }],
      thread: [report(['work-1  x'])],
    })
    for (const line of screenText(s).body.split('\n')) {
      expect(line).not.toEndWith('…')
    }
  })

  // Both halves were on one line to begin with and both were crushed: a
  // forty-character label and a sentence, each given a third of the width.
  test('a session takes two lines - its name, then what the steward said', () => {
    const s = state({
      sessions: sessions('端末ChromeのCDPデバッグ化とHrdle修正リリース — 完了'),
      lines: [{ sessionId: 'w1', text: 'レビュー待ち。1件は設計が変わる規模です', at: 1 }],
    })
    const lines = screenText(s).body.split('\n')
    expect(lines[0]).toContain('端末Chrome')
    expect(lines[1]).toStartWith('    ')
    expect(lines[1]).toContain('レビュー待ち')
  })

  // An empty second line spends the budget on saying nothing.
  test('a session the steward has not written about takes one line', () => {
    const s = state({ sessions: sessions('work-1') })
    const lines = screenText(s).body.split('\n')
    expect(lines[0]).toContain('work-1')
    expect(lines[1]).toContain('Talk to the steward')
  })

  // Half a session is a name with somebody else's line under it.
  test('a row is drawn whole or not at all', () => {
    const many = sessions(...Array.from({ length: 12 }, (_, i) => `work-${i + 1}`))
    const s = state({
      sessions: many,
      lines: many.map((session) => ({ sessionId: session.id, text: 'waiting on review', at: 1 })),
      cursor: 6,
    })
    const lines = screenText(s).body.split('\n')
    expect(lines.length).toBeLessThanOrEqual(LIST_LINES)
    // Every name line is followed by its own indented line.
    for (const [i, line] of lines.entries()) {
      if (line.includes('work-')) expect(lines[i + 1]).toStartWith('    ')
    }
  })

  test('the row under the cursor is always on screen', () => {
    const many = sessions(...Array.from({ length: 20 }, (_, i) => `work-${i + 1}`))
    const withLines = many.map((session) => ({ sessionId: session.id, text: 'x', at: 1 }))
    for (const cursor of [0, 5, 12, 19]) {
      const s = state({ sessions: many, lines: withLines, cursor })
      // The cursor, then the status column, then the name.
      expect(screenText(s).body).toContain(`> ${BADGE_BLANK}${many[cursor]?.name}`)
    }
  })

  test('an empty list before the first frame says it is connecting', () => {
    expect(screenText(initialState()).body).toBe('Connecting...')
  })
})

describe('session', () => {
  test('the newest turn is the first page, and one turn never shares a page', () => {
    const s = state({
      sessions: sessions('work-1'),
      openSessionId: 'w1',
      turns: new Map([['w1', [turn('t1', 'older'), turn('t2', 'newest')]]]),
    })
    const pages = sessionPages(s)
    expect(pages[0]?.join(' ')).toContain('newest')
    expect(pages[0]?.join(' ')).not.toContain('older')
    expect(sessionPageCount(s)).toBe(2)
  })

  test('what the wearer said is marked as theirs', () => {
    const s = state({
      sessions: sessions('work-1'),
      openSessionId: 'w1',
      turns: new Map([['w1', [turn('t1', 'go ahead', 'user')]]]),
    })
    // `$`, the shell's own convention and the mark the direct screen uses. An
    // indent was tried and costs a column off every line of a wearer turn.
    expect(sessionPages(s)[0]?.[0]).toBe('$ go ahead')
  })

  test('the direct row is pinned to the last line whatever the page holds', () => {
    const s = state({
      screen: 'session',
      sessions: sessions('work-1'),
      openSessionId: 'w1',
      turns: new Map([['w1', [turn('t1', 'one short line')]]]),
    })
    const lines = screenText(s).body.split('\n')
    expect(lines).toHaveLength(MAX_LINES)
    expect(lines[lines.length - 1]).toContain('Talk to this session directly')
  })

  test('page -1 selects the direct row and the footer says so', () => {
    const s = state({
      screen: 'session',
      sessions: sessions('work-1'),
      openSessionId: 'w1',
      sessionPage: -1,
      turns: new Map([['w1', [turn('t1', 'anything')]]]),
    })
    const screen = screenText(s)
    expect(screen.body.split('\n').pop()).toStartWith('> ')
    expect(screen.footer).toContain('tap:go direct')
  })

  test('a session with nothing written says which of the two it is', () => {
    const waiting = screenText(state({ screen: 'session', sessions: sessions('work-1'), openSessionId: 'w1', sessionWaiting: true }))
    expect(waiting.body).toContain('reading this session')

    const empty = screenText(state({ screen: 'session', sessions: sessions('work-1'), openSessionId: 'w1' }))
    expect(empty.body).toContain('Nothing written')
  })
})

describe('a question', () => {
  test('single walks the choices alone', () => {
    const rows = askRows({ id: 'a', mode: 'single', choices: ['a', 'b'] })
    expect(rows.map((r) => r.kind)).toEqual(['choice', 'choice'])
  })

  // A multi-select needs three verbs where a single pick needs two, and there
  // is no third gesture - so the third becomes a row.
  test('multi adds the row that sends', () => {
    const rows = askRows({ id: 'a', mode: 'multi', choices: ['a', 'b'] })
    expect(rows.map((r) => r.kind)).toEqual(['choice', 'choice', 'send'])
  })

  test('free text keeps its choices and adds a row for saying something else', () => {
    const rows = askRows({ id: 'a', mode: 'freeText', choices: ['a']  })
    expect(rows.map((r) => r.kind)).toEqual(['choice', 'speak'])
  })

  // One promise for the whole screen is what made a picker lie about itself in
  // the other app: on a multi-select a tap does one of two things by row.
  test('the footer says what this row does, not what the screen does', () => {
    const multi = { id: 'a', mode: 'multi' as const, choices: ['a', 'b'] }
    expect(askFooter(multi, state({ askCursor: 0 }))).toContain('tap:tick')
    expect(askFooter(multi, state({ askCursor: 2 }))).toContain('tap:send')
  })

  test('it names the session it is about, and its place in a chain', () => {
    const s = state({
      sessions: sessions('work-1'),
      screen: 'ask',
      ask: ask({ sessionId: 'w1', step: { index: 2, total: 3 } }),
    })
    expect(screenText(s).header).toContain('work-1')
    expect(screenText(s).header).toContain('(2/3)')
  })

  // Workspace labels here run to forty characters with a status suffix on the
  // end, and the bar shortens from the right - so the whole of "is asking" was
  // being cut off, leaving a question headed by a name and nothing to say it
  // was a question.
  test('a long session name is what yields in the bar, not the word "asking"', () => {
    const long: Session[] = [{ id: 'w1', name: '端末ChromeのCDPデバッグ化とHrdle修正リリース — 完了' }]
    const s = state({ sessions: long, screen: 'ask', ask: ask({ sessionId: 'w1' }) })
    expect(screenText(s).header).toContain('is asking')
  })

  // The server fits a turn's text to a whole page; a question has to share that
  // page with its own answers, and an option the wearer cannot see is one they
  // confirm blind.
  test('the choices are served first and the question takes what is left', () => {
    const s = state({
      screen: 'ask',
      ask: ask({ choices: ['yes', 'no'] }),
    })
    const s2 = {
      ...s,
      ask: {
        ...(s.ask as StewardThreadItem),
        text: 'あ'.repeat(300),
      } as StewardThreadItem,
    }
    const body = screenText(s2).body
    expect(bodyLines(body)).toBeLessThanOrEqual(MAX_LINES)
    expect(body).toContain('1 yes')
    expect(body).toContain('2 no')
    // Cut, and saying so - the rest of it is on the phone.
    expect(body).toContain('…')
  })

  test('ticked options are drawn as ticked', () => {
    const s = state({
      screen: 'ask',
      ask: ask({ mode: 'multi', choices: ['one', 'two'] }),
      askChecked: [1],
    })
    const body = screenText(s).body
    expect(body).toContain('[ ] one')
    expect(body).toContain('[x] two')
  })

  test('a long question with many choices still fits the panel', () => {
    const s = state({
      screen: 'ask',
      ask: ask({
        mode: 'multi',
        choices: Array.from({ length: 9 }, (_, i) => `option number ${i + 1} with a long label`),
      }),
      askCursor: 8,
    })
    expect(bodyLines(screenText(s).body)).toBeLessThanOrEqual(MAX_LINES)
  })
})

describe('report', () => {
  test('the heading is the bar and the rows are the body', () => {
    const s = state({ screen: 'report', thread: [report(['work-1  waiting  12m', 'life  done  31m'])] })
    const screen = screenText(s)
    expect(screen.header).toContain('3 sessions are stuck')
    expect(screen.body).toContain('work-1')
    expect(screen.body).toContain('life')
  })

  test('more rows than fit are windowed rather than dropped', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `w${i}  stuck  ${i}m`)
    const s = state({ screen: 'report', thread: [report(rows)], reportCursor: 19 })
    const body = screenText(s).body
    expect(body.split('\n').length).toBeLessThanOrEqual(MAX_LINES)
    expect(body).toContain('w19')
  })
})

describe('voice', () => {
  test('each phase says what a tap will do', () => {
    const base = { target: { kind: 'steward' as const }, phrases: [], level: 0 }
    expect(screenText(state({ screen: 'voice', voice: { ...base, phase: 'recording' } })).footer)
      .toContain('tap:stop')
    expect(screenText(state({ screen: 'voice', voice: { ...base, phase: 'transcribing' } })).body)
      .toContain('Transcribing')
    expect(
      screenText(
        state({
          screen: 'voice',
          voice: { ...base, phase: 'confirm', phrases: [{ kind: 'text', text: 'do it' }] },
        }),
      ).footer,
    ).toContain('tap:send')
  })

  // Nothing heard and nothing delivered are different failures, and the wearer
  // does something different about each.
  test('a failed request is not reported as silence', () => {
    const failed = screenText(
      state({
        screen: 'voice',
        voice: { phase: 'confirm', target: { kind: 'steward' }, phrases: [], level: 0, error: 'network' },
      }),
    )
    expect(failed.body).toContain('not the problem')

    const silent = screenText(
      state({ screen: 'voice', voice: { phase: 'confirm', target: { kind: 'steward' }, phrases: [], level: 0 } }),
    )
    expect(silent.body).toContain('nothing was recognized')
  })

  test('the bar says who is being spoken to', () => {
    const s = state({
      sessions: sessions('work-1'),
      screen: 'voice',
      voice: { phase: 'recording', target: { kind: 'pane', sessionId: 'w1' }, phrases: [], level: 0 },
    })
    expect(screenText(s).header).toContain('work-1')
    expect(screenText(s).header).toContain('directly')
  })
})

describe('a deferred question', () => {
  test('is a strip, not a screen', () => {
    const s = state({
      screen: 'direct',
      sessions: sessions('work-1'),
      openSessionId: 'w1',
      deferredAskId: 'a1',
    })
    expect(deferredNotice(s)).toBe('A question is waiting')
    expect(screenText(s).notice).toBe('A question is waiting')
    expect(screenText(s).body).not.toContain('A question is waiting')
  })

  test('the overview never carries one - it would have been shown instead', () => {
    const s = state({ sessions: sessions('work-1'), deferredAskId: 'a1' })
    expect(screenText(s).notice).toBeUndefined()
  })
})
