// A workspace with several panes is one row until it is opened.
//
// The panes used to be listed under their heading always, and the heading was
// a row the cursor stepped over. Three workspaces of three panes each is
// twelve rows on a seven-line screen, most of them panes nobody was looking
// for. Shut, the same list is three rows; a tap on the heading opens one, and
// only a pane's own row leads into a conversation.
import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import { expandedSet, listRows, rowCursor } from '../display.ts'
import type { AppState } from '../display.ts'
import type { Session } from '../types.ts'

const sessions: Session[] = [
  { id: 'a', name: 'one', state: 'idle', panes: [{ paneId: '%1' }] },
  { id: 'b', name: 'two', state: 'idle', panes: [{ paneId: '%1' }, { paneId: '%2' }] },
  { id: 'c', name: 'three', state: 'idle' },
]

function state(over: Partial<AppState> = {}): AppState {
  return {
    mode: 'session_list',
    sessions,
    sessionIndex: 0,
    conversation: [],
    conversationOffset: 0,
    conversationPage: 0,
    conversationLastLoaded: 0,
    conversationHasMore: false,
    conversationLoading: false,
    choiceIndex: 0,
    choiceOptions: [],
    relayWaiting: [],
    relayInfo: [],
    overlayItemId: null,
    ...over,
  } as AppState
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

function controllerOn(st: AppState) {
  const c = new GlassesController(stubPlatform() as never)
  Object.assign(c.state, st)
  return c
}

describe('a cursor moved by something other than the ring', () => {
  // Seen on the device (2026-09-10): back on the list after a conversation in
  // one workspace, another workspace at the top stood open. A phone had that
  // one focused; following it moved the cursor with the previous workspace's
  // pane id still in hand, and pane ids repeat across workspaces.
  const arrive = (c: GlassesController, sessions: Session[], focus?: { sessionId: string }) =>
    (c as unknown as { onSessionsUpdated(s: Session[], f?: { sessionId: string; deviceType: string; at: number }): void })
      .onSessionsUpdated(sessions, focus ? { ...focus, deviceType: 'mobile', at: 1 } : undefined)

  test('following a phone onto a folded workspace leaves it folded', () => {
    const c = controllerOn(state({ sessionIndex: 0, selectedPaneId: '%1' }))
    ;(c as unknown as { lastGestureAt: number }).lastGestureAt = 0
    arrive(c, sessions, { sessionId: 'b' })
    expect(c.state.sessionIndex).toBe(1)
    expect(c.state.selectedPaneId).toBeUndefined()
    expect(expandedSet(c.state).has('b')).toBe(false)
    expect(listRows(c.state.sessions, false, expandedSet(c.state))).toHaveLength(3)
  })

  test('a question jumps to its own pane, not to the previous workspace\'s', async () => {
    const c = controllerOn(state({ sessionIndex: 0, selectedPaneId: '%1' }))
    await (c as unknown as { jumpToItem(i: unknown): Promise<void> }).jumpToItem({ id: 'q1', kind: 'waiting', sessionId: 'b', paneId: '%2', text: 'which?', createdAt: 1 })
    expect(c.state.sessionIndex).toBe(1)
    expect(c.state.selectedPaneId).toBe('%2')
    const plain = controllerOn(state({ sessionIndex: 1, selectedPaneId: '%2' }))
    await (plain as unknown as { jumpToItem(i: unknown): Promise<void> }).jumpToItem({ id: 'q2', kind: 'waiting', sessionId: 'a', text: 'done', createdAt: 1 })
    expect(plain.state.selectedPaneId).toBeUndefined()
  })
})

describe('the fold', () => {
  test('the cursor stops on a heading rather than stepping over it', () => {
    const c = controllerOn(state({ sessionIndex: 0 }))
    c.swipeDown()
    expect(c.state.sessionIndex).toBe(1)
    expect(c.state.selectedPaneId).toBeUndefined()
    expect(rowCursor(c.state)).toBe(1)
    c.swipeDown()
    // Shut, so the next row is the workspace after it, not a pane.
    expect(c.state.sessionIndex).toBe(2)
  })

  test('a tap on a heading opens it, and the cursor stays on the heading', () => {
    const c = controllerOn(state({ sessionIndex: 1 }))
    c.tap()
    expect(c.state.mode).toBe('session_list')
    expect(c.state.expandedWorkspaces).toEqual(['b'])
    expect(rowCursor(c.state)).toBe(1)
    c.swipeDown()
    expect(c.state.selectedPaneId).toBe('%1')
  })

  test('a tap on an open heading shuts it', () => {
    const c = controllerOn(state({ sessionIndex: 1, expandedWorkspaces: ['b'] }))
    c.tap()
    expect(c.state.expandedWorkspaces).toEqual([])
    expect(listRows(c.state.sessions, false, expandedSet(c.state))).toHaveLength(3)
  })

  test('a pane chosen from elsewhere shows its workspace open without a tap', () => {
    // A question jumps the cursor onto its pane; the fold must not hide it.
    expect(expandedSet(state({ sessionIndex: 1, selectedPaneId: '%2' })).has('b')).toBe(true)
    expect(expandedSet(state({ sessionIndex: 1 })).has('b')).toBe(false)
  })

  test('swiping up from the row under a heading lands on the heading', () => {
    const c = controllerOn(state({ sessionIndex: 1, selectedPaneId: '%1', expandedWorkspaces: ['b'] }))
    c.swipeUp()
    expect(c.state.sessionIndex).toBe(1)
    expect(c.state.selectedPaneId).toBeUndefined()
  })
})
