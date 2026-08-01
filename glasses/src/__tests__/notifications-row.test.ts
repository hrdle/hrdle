// Reaching the notices on purpose.
//
// The overlay has always been a browsable list of every waiting question and
// every notification — a counter in the header, `swipe:next` to walk it. Nothing
// could open it deliberately: it appeared when a question arrived, and that was
// the only way in. So a wearer who dismissed it, or who wanted to reread a
// notice from ten minutes ago, had no route back, and the list showed `+2` while
// offering no way to reach the two.
//
// These cover the route: the line the notices were already printed on, turned
// into somewhere the cursor can rest and something the ring can open.

import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import { hasNotificationRow, listRows, rowCursor, screenText, selectableRows } from '../display.ts'
import { BODY_WIDTH, textWidth as width } from '../metrics.ts'
import type { AppState } from '../display.ts'
import type { GlassesRelayItem, Session } from '../types.ts'

const sessions = (n: number): Session[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: `ws${i}`,
    state: 'idle' as const,
  })) as Session[]

const item = (kind: 'waiting' | 'info', id: string): GlassesRelayItem =>
  ({
    id,
    kind,
    sessionId: 's0',
    text: `${kind} ${id}`,
    createdAt: 1,
  }) as GlassesRelayItem

function state(over: Partial<AppState> = {}): AppState {
  return {
    mode: 'session_list',
    sessions: sessions(3),
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

/** A controller holding `st`, without a socket or any timers. */
function controllerOn(st: AppState) {
  const c = new GlassesController(stubPlatform() as never)
  Object.assign(c.state, st)
  return c
}

describe('the notifications row exists only when there is something behind it', () => {
  test('no items, no row', () => {
    expect(hasNotificationRow(state())).toBe(false)
    expect(listRows(state().sessions, false)[0].notifications).toBeUndefined()
  })

  test('an info item alone is enough', () => {
    expect(hasNotificationRow(state({ relayInfo: [item('info', 'i1')] }))).toBe(true)
  })

  test('a waiting item alone is enough', () => {
    // The banner this replaces only appeared for info items, so a wearer who
    // dismissed a question's overlay had nothing to go back to.
    expect(hasNotificationRow(state({ relayWaiting: [item('waiting', 'w1')] }))).toBe(true)
  })

  test('it is first, and it is selectable', () => {
    const rows = listRows(sessions(3), true)
    expect(rows[0].notifications).toBe(true)
    expect(selectableRows(sessions(3), true)[0].notifications).toBe(true)
    expect(rows).toHaveLength(4)
  })
})

describe('the cursor', () => {
  test('rests on the row when the flag is set', () => {
    const st = state({ relayInfo: [item('info', 'i1')], listOnNotifications: true })
    expect(rowCursor(st)).toBe(0)
  })

  test('a flag left behind after the notices clear points at a session again', () => {
    // The items can vanish underneath the cursor — a question gets answered on
    // the PC, a notice's TTL expires. Row 0 is then a session.
    const st = state({ listOnNotifications: true, sessionIndex: 1 })
    expect(hasNotificationRow(st)).toBe(false)
    expect(rowCursor(st)).toBe(1)
  })

  test('swiping down leaves the row and lands on the first session', () => {
    const c = controllerOn(state({ relayInfo: [item('info', 'i1')], listOnNotifications: true }))
    c.swipeDown()
    expect(c.state.listOnNotifications).toBe(false)
    expect(rowCursor(c.state)).toBe(1)
  })

  test('swiping up from the first session lands on the row', () => {
    const c = controllerOn(state({ relayInfo: [item('info', 'i1')], sessionIndex: 0 }))
    c.swipeUp()
    expect(c.state.listOnNotifications).toBe(true)
    expect(rowCursor(c.state)).toBe(0)
  })

  test('coming back off the row returns to the session it left', () => {
    // The row is neither a session nor a pane, so the session fields are left
    // alone while the cursor is on it. Without that, stepping onto the notices
    // and back would drop the reader at the top of the list.
    const c = controllerOn(state({ relayInfo: [item('info', 'i1')], sessionIndex: 2 }))
    c.swipeUp() // 2 -> 1
    c.swipeUp() // 1 -> 0
    c.swipeUp() // 0 -> notices
    expect(c.state.listOnNotifications).toBe(true)
    c.swipeDown()
    expect(c.state.sessionIndex).toBe(0)
  })

  test('swiping up from the row goes nowhere', () => {
    const c = controllerOn(state({ relayInfo: [item('info', 'i1')], listOnNotifications: true }))
    c.swipeUp()
    expect(c.state.listOnNotifications).toBe(true)
    expect(rowCursor(c.state)).toBe(0)
  })
})

describe('tapping the row opens the notices', () => {
  test('it enters the overlay rather than a conversation', async () => {
    const c = controllerOn(state({ relayWaiting: [item('waiting', 'w1')], listOnNotifications: true }))
    c.tap()
    await Promise.resolve()
    expect(c.state.mode).toBe('overlay')
  })

  test('info items alone still open it', async () => {
    // `enterOverlay` defaults its target to the top waiting item, of which there
    // is none here — the overlay falls back to the first item it has.
    const c = controllerOn(state({ relayInfo: [item('info', 'i1')], listOnNotifications: true }))
    c.tap()
    await Promise.resolve()
    expect(c.state.mode).toBe('overlay')
  })

  test('a session row still opens its conversation', async () => {
    const c = controllerOn(state({ relayInfo: [item('info', 'i1')], sessionIndex: 1 }))
    c.tap()
    await Promise.resolve()
    expect(c.state.mode).toBe('conversation')
  })

  test('a stale flag with no notices left does not open an empty overlay', async () => {
    const c = controllerOn(state({ listOnNotifications: true, sessionIndex: 1 }))
    c.tap()
    await Promise.resolve()
    expect(c.state.mode).toBe('conversation')
  })
})

describe('the row is one line, marker included', () => {
  // The first version wrapped the text on its own and prepended the cursor
  // column afterwards, so a full-width notice spilled one character onto a
  // second row. The unit tests passed; the panel showed it.
  test('a long notice never takes a second line', () => {
    const st = state({ relayInfo: [item('info', 'i1')] })
    st.relayInfo[0].text = 'あ'.repeat(200)
    for (const on of [false, true]) {
      const screen = screenText({ ...st, listOnNotifications: on })
      expect(width(screen.notice ?? '')).toBeLessThanOrEqual(BODY_WIDTH)
      expect((screen.notice ?? '').split('\n')).toHaveLength(1)
      // The list below it starts with a session, not the rest of the notice.
      expect(screen.body.split('\n')[0]).toContain('ws')
    }
  })

  test('the cursor marker does not change how much text fits', () => {
    const st = state({ relayInfo: [item('info', 'i1')] })
    st.relayInfo[0].text = 'あ'.repeat(200)
    // Compared after the marker, because the marker is what differs: `>` is
    // one character and the blank standing in for it is two, chosen to come to
    // the same 10px. What has to match is the message - the same amount of it
    // survives the wrap either way, which is what this row's budget is about.
    // (The rendered widths land 1px apart: `advance` adjusts on the preceding
    // character, and the character before the badge is not the same one.)
    const strip = (s: string) => s.replace(/^(>|  )/, '')
    const off = strip(screenText({ ...st, listOnNotifications: false }).notice ?? '')
    const on = strip(screenText({ ...st, listOnNotifications: true }).notice ?? '')
    expect(off).toBe(on)
  })
})
