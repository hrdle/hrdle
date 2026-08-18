// Where the session screen is standing, and who is talking on it.
//
// One page is one turn, numbered from the newest, so **a turn arriving
// renumbers every page**. Held by its number, page 0 - where the screen opens,
// and where someone who has just spoken is standing - showed the arriving turn
// and moved theirs to page 1 with nothing on the panel to say so. Reported
// three times as "my message disappeared"; it was there every time, one swipe
// away.
//
// So three things have to hold together, and each of them breaks the other two
// if it goes in alone: the page is anchored to its turn, the wearer's own
// sentence appears without waiting for the round trip, and a turn arriving
// while they are held says so.

import { describe, expect, mock, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import { initialState, screenText, sessionPageKeys, sessionPages, sessionTurns } from '../display.ts'
import type { AppState } from '../display.ts'
import type { Session, StewardTurn } from '../types.ts'

;(globalThis as unknown as { __PRODUCT_NAME__: string }).__PRODUCT_NAME__ = 'Hrdle'
;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.4'
;(globalThis as unknown as { __BUILD_COMMIT__: string }).__BUILD_COMMIT__ = 'test'

function turn(id: string, role: StewardTurn['role'], text: string): StewardTurn {
  return { id, at: 1, role, text }
}

function state(turns: StewardTurn[], over: Partial<AppState> = {}): AppState {
  const s: AppState = {
    ...initialState(),
    connected: true,
    screen: 'session',
    openSessionId: 'w1',
    sessions: [{ id: 'w1', name: 'work-1' }],
    ...over,
  }
  s.turns.set('w1', turns)
  return s
}

function platform(): GlassesPlatform {
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
  }
}

type Internals = {
  onSessions(sessions: Session[]): void
  onTurns(sessionId: string, paneId: string | undefined, turns: StewardTurn[]): void
  deliver(target: unknown, text: string): Promise<void>
  state: AppState
}

function opened(turns: StewardTurn[], panes?: Session['panes']): { c: GlassesController; inner: Internals } {
  const c = new GlassesController(platform())
  const inner = c as unknown as Internals
  inner.onSessions([{ id: 'w1', name: 'work-1', panes }])
  c.state.screen = 'session'
  c.state.openSessionId = 'w1'
  inner.onTurns('w1', panes && panes.filter((p) => p.agent).length > 1 ? '%6' : undefined, turns)
  return { c, inner }
}

describe('the page stays on the turn it is showing', () => {
  test('a turn arriving does not move the reader off page 0', () => {
    const { c, inner } = opened([turn('t1', 'user', 'ship it')])
    expect(screenText(c.state).body).toContain('ship it')

    inner.onTurns('w1', undefined, [turn('t1', 'user', 'ship it'), turn('t2', 'steward', 'shipped')])

    // The number moved; what is on the page did not.
    expect(c.state.sessionPage).toBe(1)
    expect(screenText(c.state).body).toContain('ship it')
    expect(screenText(c.state).body).not.toContain('shipped')
  })

  test('and paging up reaches what arrived', () => {
    const { c, inner } = opened([turn('t1', 'user', 'ship it')])
    inner.onTurns('w1', undefined, [turn('t1', 'user', 'ship it'), turn('t2', 'steward', 'shipped')])
    c.swipeUp()
    expect(screenText(c.state).body).toContain('shipped')
  })

  test('a page that no longer exists falls back rather than reading empty', () => {
    const { c, inner } = opened([turn('t1', 'user', 'one'), turn('t2', 'steward', 'two')])
    c.state.sessionPage = 1
    inner.onTurns('w1', undefined, [turn('t2', 'steward', 'two')])
    expect(c.state.sessionPage).toBe(0)
    expect(screenText(c.state).body).toContain('two')
  })

  // The anchor names a piece of a turn, not the turn, or a reader halfway
  // through a long one is put back at its first line every time it is amended.
  test('the anchor holds inside a turn that spans several pages', () => {
    const long = turn('t1', 'steward', Array.from({ length: 120 }, (_, i) => `line ${i}`).join(' '))
    const { c, inner } = opened([long])
    expect(sessionPages(c.state).length).toBeGreaterThan(1)
    c.state.sessionPage = 1
    const showing = sessionPages(c.state)[1]

    inner.onTurns('w1', undefined, [long, turn('t2', 'steward', 'and one more')])
    expect(sessionPages(c.state)[c.state.sessionPage]).toEqual(showing)
  })
})

describe('a turn arriving while the reader is held', () => {
  test('is counted in the header, because nothing else on the panel changed', () => {
    const { c, inner } = opened([turn('t1', 'user', 'ship it')])
    expect(screenText(c.state).header).not.toContain('+')

    inner.onTurns('w1', undefined, [turn('t1', 'user', 'ship it'), turn('t2', 'steward', 'shipped')])
    expect(screenText(c.state).header).toContain('+1')

    inner.onTurns('w1', undefined, [
      turn('t1', 'user', 'ship it'),
      turn('t2', 'steward', 'shipped'),
      turn('t3', 'steward', 'and tagged'),
    ])
    expect(screenText(c.state).header).toContain('+2')
  })

  test('the count is answered by going to look', () => {
    const { c, inner } = opened([turn('t1', 'user', 'ship it')])
    inner.onTurns('w1', undefined, [turn('t1', 'user', 'ship it'), turn('t2', 'steward', 'shipped')])
    c.swipeUp()
    expect(screenText(c.state).header).not.toContain('+')
  })

  // Amending a turn already read is not news.
  test('an edit that leaves the reader where they are says nothing', () => {
    const { c, inner } = opened([turn('t1', 'user', 'ship it'), turn('t2', 'steward', 'shipped')])
    inner.onTurns('w1', undefined, [turn('t1', 'user', 'ship it'), turn('t2', 'steward', 'shipped, and tagged')])
    expect(screenText(c.state).header).not.toContain('+')
  })
})

describe("the wearer's own sentence", () => {
  test('is on the screen before the server has it', async () => {
    const { c, inner } = opened([turn('t1', 'steward', 'nothing to report')])
    // Never resolves: the whole point is what is on the panel while the round
    // trip is in flight.
    globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch

    void inner.deliver({ kind: 'steward-session', sessionId: 'w1' }, 'what about the tests')
    await Promise.resolve()

    expect(screenText(c.state).body).toContain('what about the tests')
    expect(c.state.sessionPage).toBe(0)
  })

  test('is not shown twice when the server sends its own copy back', async () => {
    const { c, inner } = opened([])
    globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch
    void inner.deliver({ kind: 'steward-session', sessionId: 'w1' }, 'hello')
    await Promise.resolve()
    expect(sessionTurns(c.state)).toHaveLength(1)

    inner.onTurns('w1', undefined, [turn('server-id', 'user', 'hello')])
    expect(sessionTurns(c.state)).toHaveLength(1)
    expect(sessionTurns(c.state)[0].id).toBe('server-id')
  })

  test('survives a history load that has not caught up', async () => {
    const { c, inner } = opened([])
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ turns: [] }))) as unknown as typeof fetch
    void inner.deliver({ kind: 'steward-session', sessionId: 'w1' }, 'hello')
    await Promise.resolve()

    inner.onTurns('w1', undefined, [])
    expect(screenText(c.state).body).toContain('hello')
  })
})

describe('who said it', () => {
  // The panel is monochrome, so the two voices are told apart by where the line
  // starts. The lead is only on the first line of a wrapped turn; the indent is
  // on all of them.
  test("the wearer's turn is led and indented, the steward's is flush", () => {
    const s = state([turn('t1', 'user', 'a'.repeat(200))])
    const page = sessionPages(s)[0]
    expect(page[0]).toStartWith('    You: ')
    expect(page[1]).toStartWith('    ')

    const steward = sessionPages(state([turn('t2', 'steward', 'shipped')]))[0]
    expect(steward[0]).toBe('shipped')
  })

  test('the indent does not push a wearer line past the panel', () => {
    const s = state([turn('t1', 'user', 'ship it '.repeat(40))])
    const plain = sessionPages(state([turn('t2', 'steward', 'ship it '.repeat(40))]))
    for (const line of sessionPages(s).flat()) {
      expect(line.length).toBeLessThanOrEqual(Math.max(...plain.flat().map((l) => l.length)) + 4)
    }
  })
})

describe('a workspace with two agents', () => {
  // Written under `w2H:%6` and read back under `w2H`, its history was stored
  // correctly and displayed as empty.
  test('reads the history back from the pane it was written to', () => {
    const panes: Session['panes'] = [
      { paneId: '%1', agent: 'claude' },
      { paneId: '%6', agent: 'claude', isActive: true },
    ]
    const { c } = opened([turn('t1', 'steward', 'the recipe pane is waiting')], panes)
    expect(screenText(c.state).body).toContain('the recipe pane is waiting')
    expect(sessionPageKeys(c.state)).toEqual(['t1#0'])
  })
})
