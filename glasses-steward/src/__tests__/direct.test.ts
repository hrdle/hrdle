// The one screen the steward does not write.
//
// Everything else on these glasses is a sentence that arrived complete. Direct
// mode is a pane's own conversation, and the decision this file holds is what
// shape that arrives in: **not the terminal's output**, which is escape
// sequences and a redrawing spinner, but the reserved format the other glasses
// app spent months arriving at - a mark for whose turn it is, one line per tool
// call saying what the call was about, and Markdown unwrapped rather than
// printed as syntax.
//
// The paging is asserted as hard as the format, because a page that drops a
// line drops it silently: the reader is shown seven lines either way and
// nothing on the panel says one is missing.

import { describe, expect, mock, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import { conversationPages, filterConversation, formatMessage } from '../conversation.ts'
import { directPages, initialState, screenText } from '../display.ts'
import type { AppState } from '../display.ts'
import { MAX_LINES } from '../metrics.ts'
import type { ConversationMessage, Session } from '../types.ts'

;(globalThis as unknown as { __PRODUCT_NAME__: string }).__PRODUCT_NAME__ = 'Hrdle'
;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.1'
;(globalThis as unknown as { __BUILD_COMMIT__: string }).__BUILD_COMMIT__ = 'test'

function state(over: Partial<AppState> = {}): AppState {
  return { ...initialState(), connected: true, screen: 'direct', openSessionId: 'w1', ...over }
}

function sessions(): Session[] {
  return [
    {
      id: 'w1',
      name: 'work-1',
      panes: [{ paneId: '%1', isActive: true, agent: 'claude', agentSessionId: 'cc-1' }],
    },
  ]
}

describe('a turn, in the format the panel reserves for it', () => {
  test('the user is marked and the agent is not', () => {
    expect(formatMessage({ role: 'user', content: 'ship it' })).toBe('$ ship it')
    expect(formatMessage({ role: 'assistant', content: 'shipped' })).toBe('shipped')
  })

  // A bare list of names ("[Read] [Read] [Bash]") says nothing about what the
  // agent is doing, which is the only reason to be on this screen.
  test('a tool call says what it was about, not only which tool it was', () => {
    const out = formatMessage({
      role: 'assistant',
      content: 'Looking at the workflow.',
      toolUse: [{ name: 'Read', input: { file_path: '/home/you/repo/.github/workflows/release.yml' } }],
    })
    expect(out).toContain('[Read]')
    expect(out).toContain('workflows/release.yml')
  })

  // Read by field rather than by tool name: every agent names its arguments
  // differently, and a switch on the name fails silently on the ones it has
  // not been taught.
  test('it reads an argument no rule was written for', () => {
    const out = formatMessage({
      role: 'assistant',
      content: '',
      toolUse: [{ name: 'SomeNewTool', input: { session_id: 'abc', target_file: 'src/app.ts' } }],
    })
    expect(out).toContain('src/app.ts')
    expect(out).not.toContain('abc')
  })

  test('Markdown is unwrapped, not printed', () => {
    const out = formatMessage({ role: 'assistant', content: '## Done\nThe **upload** step ran [early](http://x).' })
    expect(out).toBe('Done\nThe upload step ran early.')
  })

  test('a fenced block is shown when it fits and counted when it does not', () => {
    const short = formatMessage({ role: 'assistant', content: '```\ngit push\n```' })
    expect(short).toBe('git push')
    const long = formatMessage({ role: 'assistant', content: `\`\`\`\n${'x\n'.repeat(9)}\`\`\`` })
    expect(long).toBe('[code 9 lines]')
  })

  // The output is truncated to the point of saying nothing, and the call above
  // it already said what it was.
  test('a message that is only a tool result is dropped', () => {
    const kept = filterConversation([
      { role: 'assistant', content: 'reading', toolUse: [{ name: 'Read', input: { path: 'a.ts' } }] },
      { role: 'user', content: '', toolResult: [{ toolName: 'Read', output: 'export const a = 1' }] },
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0].role).toBe('assistant')
  })
})

describe('paging a pane', () => {
  const long = (n: number): ConversationMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: 'assistant' as const, content: `line ${i}` }))

  test('page 0 is the live end, so a swipe walks back in time', () => {
    const pages = conversationPages(long(20), MAX_LINES)
    expect(pages[0][pages[0].length - 1]).toBe('line 19')
    expect(pages[1][pages[1].length - 1]).toBe(`line ${19 - MAX_LINES}`)
  })

  // A hole at a page boundary is invisible: seven lines are drawn either way.
  test('the pages tile - no line on two of them, none on neither', () => {
    const msgs = long(23)
    const seen = conversationPages(msgs, MAX_LINES).reverse().flat()
    expect(seen).toEqual(msgs.map((m) => m.content))
  })

  // A page that begins on the last line of the turn before it reads as the
  // wrong answer to the question above it.
  test('a turn that fits is kept whole rather than split at the page edge', () => {
    const msgs: ConversationMessage[] = [
      { role: 'user', content: 'ship it\nwhen the tests pass' },
      { role: 'assistant', content: Array.from({ length: MAX_LINES - 1 }, (_, i) => `r${i}`).join('\n') },
    ]
    const pages = conversationPages(msgs, MAX_LINES)
    expect(pages[0]).toEqual(Array.from({ length: MAX_LINES - 1 }, (_, i) => `r${i}`))
    expect(pages[1]).toEqual(['$ ship it', 'when the tests pass'])
  })

  test('a turn longer than a page gets pages of its own, ending at the live edge', () => {
    const body = Array.from({ length: MAX_LINES + 3 }, (_, i) => `r${i}`)
    const pages = conversationPages([{ role: 'assistant', content: body.join('\n') }], MAX_LINES)
    expect(pages).toHaveLength(2)
    expect(pages[0][pages[0].length - 1]).toBe(`r${MAX_LINES + 2}`)
    expect([...pages].reverse().flat()).toEqual(body)
  })

  // The notice takes its share of the panel first. Paging by the panel's full
  // height while drawing less puts whole lines on no page at all.
  test('a waiting question shrinks the page rather than tearing it', () => {
    const msgs = long(20)
    const plain = directPages(state({ direct: msgs }))
    const withNotice = directPages(state({ direct: msgs, deferredAskId: 'a1' }))
    expect(withNotice[0].length).toBeLessThan(plain[0].length)
    expect([...withNotice].reverse().flat()).toEqual(msgs.map((m) => m.content))
  })
})

describe('the direct screen', () => {
  test('draws the transcript, and says which page of it', () => {
    const s = state({ sessions: sessions(), direct: [{ role: 'user', content: 'ship it' }] })
    const screen = screenText(s)
    expect(screen.body).toBe('$ ship it')
    expect(screen.header).toContain('work-1')
    expect(screen.footer).toContain('tap:speak')
  })

  // A transcript alone cannot say whether a silence is an agent thinking or a
  // prompt sitting there waiting - and the terminal shows that without being
  // asked.
  test('says when the pane is waiting on the wearer', () => {
    const waiting = sessions()
    waiting[0].panes = [{ paneId: '%1', isActive: true, agent: 'claude', indicatorState: 'waiting_input' }]
    expect(screenText(state({ sessions: waiting })).header).toContain('[!]')
    expect(screenText(state({ sessions: sessions() })).header).not.toContain('[!]')
  })

  test('an empty pane says so rather than drawing nothing', () => {
    expect(screenText(state({ sessions: sessions() })).body).toBe('Nothing on this pane yet.')
  })
})

describe('the pane output itself', () => {
  function controller(): GlassesController {
    return new GlassesController({
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
    })
  }

  type Internals = {
    onSessions(sessions: Session[]): void
    onTerminal(sessionId: string, text: string): void
    state: AppState
  }

  // The instruction this whole file exists for: what the pane paints is spent
  // as a signal that the transcript has moved, and never as the thing shown.
  test('is a signal to re-read the transcript, and is not itself drawn', async () => {
    const c = controller()
    const inner = c as unknown as Internals
    inner.onSessions(sessions())
    c.state.screen = 'direct'
    c.state.openSessionId = 'w1'
    const fetched = mock(
      async () => new Response(JSON.stringify({ messages: [{ role: 'assistant', content: 'the tests passed' }] })),
    )
    globalThis.fetch = fetched as unknown as typeof fetch

    inner.onTerminal('w1', '[2J$ npm test\nPASS  8 tests')
    // Asserted here, before the reload lands: the panel must not be painted
    // with the output on the way past, and the settled state cannot see that -
    // the transcript arrives a moment later and covers it over.
    expect(screenText(c.state).body).not.toContain('npm test')

    await new Promise((r) => setTimeout(r, 0))
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(screenText(c.state).body).toBe('the tests passed')
  })

  // A working pane repaints several times a second, and every repaint would
  // otherwise be a request.
  test('is throttled, and held off entirely once the reader has paged back', () => {
    const c = controller()
    const inner = c as unknown as Internals
    inner.onSessions(sessions())
    c.state.screen = 'direct'
    c.state.openSessionId = 'w1'
    const fetched = mock(async () => new Response(JSON.stringify({ messages: [] })))
    globalThis.fetch = fetched as unknown as typeof fetch

    inner.onTerminal('w1', 'a')
    inner.onTerminal('w1', 'b')
    inner.onTerminal('w1', 'c')
    expect(fetched).toHaveBeenCalledTimes(1)

    c.state.directPage = 2
    inner.onTerminal('w1', 'd')
    expect(fetched).toHaveBeenCalledTimes(1)
  })
})
