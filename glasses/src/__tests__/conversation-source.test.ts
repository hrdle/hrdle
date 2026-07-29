// Which conversation the glasses read, and by whose reader (#5).
//
// The history API defaults to Claude's jsonl and only reaches a thread agent's
// own transcript when asked by name (`?agent=`). Asking unqualified for a kimi
// session is not an error — it is an empty answer, which reached the screen as
// `(no messages)` and looked like the agent had said nothing.

import { afterEach, describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import type { ConversationMessage, Session } from '../types.ts'

const realFetch = globalThis.fetch

/** Record every URL the app asks for, answering each with the same transcript. */
function captureFetch(messages: ConversationMessage[] = [{ role: 'assistant', content: 'hi' }]) {
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify({ messages }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return urls
}

function stubPlatform() {
  return {
    onDevice: false,
    render: () => {},
    renderHeader: () => {},
    startMicCapture: async () => false,
    stopMicCapture: async () => {},
    transcribeAudio: async () => '',
    saveState: () => {},
    loadState: async () => null,
    requestExit: () => {},
    onForegroundRegained: () => {},
  }
}

/** Open a conversation the way the list does, without the ring or the socket. */
async function open(sessions: Session[], paneId?: string) {
  const c = new GlassesController(stubPlatform() as never)
  c.state.sessions = sessions as never
  c.state.sessionIndex = 0
  c.state.selectedPaneId = paneId
  const inner = c as unknown as {
    loadConversation(): Promise<void>
    loadMoreConversation(): Promise<boolean>
  }
  await inner.loadConversation()
  return { c, inner }
}

const kimiWorkspace: Session[] = [
  {
    id: 'w1',
    name: 'kimi-work',
    state: 'idle',
    agent: 'kimi',
    // The server sends this *instead of* ccSessionId for a thread agent.
    agentSessionId: 'session_4b198082-1480-45a6-a06e-180c40936985',
    panes: [
      {
        paneId: '%1',
        agent: 'kimi',
        agentSessionId: 'session_4b198082-1480-45a6-a06e-180c40936985',
      },
    ],
  },
]

describe('conversation source', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('a kimi pane is read by kimi\'s own reader', async () => {
    const urls = captureFetch()
    await open(kimiWorkspace, '%1')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/api/sessions/history/session_4b198082-1480-45a6-a06e-180c40936985/conversation')
    expect(urls[0]).toContain('agent=kimi')
  })

  test('a kimi workspace with no pane row selected still reaches its transcript', async () => {
    // The list opens a single-pane workspace by its row, which carries no
    // paneId — the case that produced `(no messages)` on the real device.
    const urls = captureFetch()
    const { c } = await open(kimiWorkspace)
    expect(urls[0]).toContain('agent=kimi')
    expect(c.state.conversation).toHaveLength(1)
  })

  test('Claude is still read unqualified', async () => {
    const urls = captureFetch()
    await open([
      {
        id: 'w2',
        name: 'claude-work',
        state: 'idle',
        agent: 'claude',
        ccSessionId: '67c7ed27-cb6f-4334-8f2c-3efe0f3c36fe',
        panes: [{ paneId: '%1', agent: 'claude', agentSessionId: '67c7ed27-cb6f-4334-8f2c-3efe0f3c36fe' }],
      },
    ], '%1')
    expect(urls[0]).toContain('/conversation?last=')
    expect(urls[0]).not.toContain('agent=')
  })

  test('paging back stays on the conversation that was opened', async () => {
    // loadMore used to re-resolve the target as the workspace's Claude
    // transcript, so paging back through a pane's history swapped it for a
    // different conversation — or, for kimi, for nothing at all.
    const full = Array.from({ length: 20 }, (_, i) => ({
      role: 'assistant' as const,
      content: `m${i}`,
    }))
    const urls = captureFetch(full)
    const { inner } = await open(kimiWorkspace, '%1')
    await inner.loadMoreConversation()
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('session_4b198082-1480-45a6-a06e-180c40936985')
    expect(urls[1]).toContain('agent=kimi')
  })
})
