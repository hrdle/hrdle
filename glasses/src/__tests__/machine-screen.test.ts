// The list is grouped by machine when there is more than one.
//
// The merged list puts every peer's sessions in one column, prefixed with the
// peer's nickname, and finding one meant walking all of them. With peers, the
// list opens on the machines; a tap on one shows its sessions and nothing
// else, and a double-tap goes back up. With no peers there is no such screen
// and the list is what it always was.
import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import { hasMachineScreen, listRowsFor, machineGroups, screenText, showingMachines } from '../display.ts'
import type { AppState } from '../display.ts'
import type { Session } from '../types.ts'
import { LIST_LINES } from '../metrics.ts'

const peered: Session[] = [
  { id: 'peer:p_mac:w1', name: 'MAC/kurassistant', state: 'idle', peerId: 'p_mac', peerNickname: 'MAC', indicatorState: 'waiting_input' },
  { id: 'peer:p_mac:w2', name: 'MAC/work', state: 'idle', peerId: 'p_mac', peerNickname: 'MAC' },
  { id: 'w1', name: 'hrdle', state: 'idle', peerId: 'local', peerNickname: 'DESK', indicatorState: 'processing' },
  { id: 'w2', name: 'smarthome', state: 'idle', peerId: 'local', peerNickname: 'DESK' },
  { id: 'peer:p_jet:w1', name: 'LAB/depth', state: 'idle', peerId: 'p_lab', peerNickname: 'LAB' },
]

const alone: Session[] = [
  { id: 'w1', name: 'hrdle', state: 'idle' },
  { id: 'w2', name: 'smarthome', state: 'idle' },
]

function state(over: Partial<AppState> = {}): AppState {
  return {
    mode: 'session_list',
    sessions: peered,
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
    spinnerTick: 0,
    ...over,
  } as AppState
}

function stubPlatform(exits: number[] = []) {
  return {
    onDevice: false,
    render: () => {},
    renderHeader: () => {},
    startMicCapture: async () => false,
    stopMicCapture: async () => {},
    transcribeAudio: async () => '',
    saveState: () => {},
    loadState: async () => null,
    requestExit: () => { exits.push(1) },
    onForegroundRegained: () => {},
  }
}

function controllerOn(st: AppState, exits: number[] = []) {
  const c = new GlassesController(stubPlatform(exits) as never)
  Object.assign(c.state, st)
  return c
}

describe('the machines', () => {
  test('are the list grouped by peer, in the order the list already has', () => {
    expect(machineGroups(state()).map((g) => [g.id, g.label, g.count, g.waiting])).toEqual([
      ['p_mac', 'MAC', 2, 1],
      ['local', 'DESK', 2, 0],
      ['p_lab', 'LAB', 1, 0],
    ])
  })

  test('there is a machine screen only with two or more of them', () => {
    expect(hasMachineScreen(state())).toBe(true)
    expect(hasMachineScreen(state({ sessions: alone }))).toBe(false)
    // Asked for but not there: one machine has nothing to choose between.
    expect(showingMachines(state({ sessions: alone, machinePick: true }))).toBe(false)
  })

  test('the session list under a machine holds that machine alone, without the prefix', () => {
    const st = state({ sessionIndex: 2 })
    expect(listRowsFor(st).map((r) => r.sessionIndex)).toEqual([2, 3])
    const body = screenText(st).body
    expect(body).toContain('[hrdle]')
    expect(body).not.toContain('kurassistant')
    const mac = screenText(state({ sessionIndex: 0 })).body
    expect(mac).toContain('[kurassistant]')
    expect(mac).not.toContain('MAC/')
  })

  test('the machine screen names each machine with its count and what is waiting', () => {
    const { body, footer } = screenText(state({ machinePick: true, machineCursor: 1 }))
    const lines = body.split('\n')
    expect(lines[0]).toMatch(/^ {2}！ MAC/)
    expect(lines[0]).toContain('!1')
    expect(lines[1].startsWith('>')).toBe(true)
    expect(lines[1]).toContain('DESK')
    expect(lines[2]).toContain('LAB')
    expect(footer).toContain('tap:open')
    expect(footer).toMatch(/2\/3/)
  })
})

describe('what the review found', () => {
  // Codex review of the first cut (2026-09-10): the machine list showed a
  // fixed first page, so a cursor past it vanished; and a machine's session
  // list carried no sign of which machine it was.
  const many: Session[] = Array.from({ length: 12 }, (_, i) => ({
    id: `peer:p${i}:w1`, name: `M${i}/ws`, state: 'idle' as const, peerId: `p${i}`, peerNickname: `M${i}`,
  }))

  test('the machine list scrolls to keep the cursor on screen', () => {
    const body = screenText(state({ sessions: many, machinePick: true, machineCursor: 11 })).body
    expect(body).toContain('>')
    expect(body).toContain('M11')
    expect(body.split('\n').length).toBeLessThanOrEqual(LIST_LINES)
  })

  test('the notices row takes one of the machine list\'s lines', () => {
    const body = screenText(state({
      sessions: many, machinePick: true, machineCursor: 0,
      relayInfo: [{ id: 'i1', kind: 'info', sessionId: 'w1', text: 'done', createdAt: 1 } as never],
    })).body
    expect(body.split('\n').length).toBeLessThanOrEqual(LIST_LINES - 1)
  })

  test('a machine\'s session list says which machine it is', () => {
    expect(screenText(state({ sessionIndex: 2 })).footer).toContain('DESK')
    expect(screenText(state({ sessionIndex: 0 })).footer).toContain('MAC')
    // No machines, no label: the bar is short and that was noise.
    expect(screenText(state({ sessions: alone })).footer).not.toContain('DESK')
  })
})

describe('what moves the cursor without a gesture', () => {
  // Seen on the device (2026-09-10): a reader looking at one machine's list
  // had it replaced by another machine's, having touched nothing. A phone
  // had opened a session there, and following it moved the cursor across.
  const arrive = (c: GlassesController, sessions: Session[], focus?: { sessionId: string }) =>
    (c as unknown as { onSessionsUpdated(s: Session[], f?: { sessionId: string }): void }).onSessionsUpdated(sessions, focus)

  test('a phone opening a session on another machine does not change the list', () => {
    const c = controllerOn(state({ sessionIndex: 2 }))
    ;(c as unknown as { lastGestureAt: number }).lastGestureAt = 0
    arrive(c, peered, { sessionId: 'peer:p_mac:w1' })
    expect(c.state.sessionIndex).toBe(2)
  })

  test('a phone opening a session on the same machine still moves the cursor', () => {
    const c = controllerOn(state({ sessionIndex: 2 }))
    ;(c as unknown as { lastGestureAt: number }).lastGestureAt = 0
    arrive(c, peered, { sessionId: 'w2' })
    expect(c.state.sessionIndex).toBe(3)
  })

  test('a session that went away leaves the cursor on its machine', () => {
    const c = controllerOn(state({ sessionIndex: 3 }))
    arrive(c, peered.filter((s) => s.id !== 'w2'))
    expect(c.state.sessions[c.state.sessionIndex].peerNickname).toBe('DESK')
  })
})

describe('moving between the levels', () => {
  test('the list opens on the machines when the sessions first arrive with peers', () => {
    const arrive = (c: GlassesController, sessions: Session[]) =>
      (c as unknown as { onSessionsUpdated(s: Session[]): void }).onSessionsUpdated(sessions)
    const c = controllerOn(state({ sessions: [] }))
    arrive(c, peered)
    expect(c.state.machinePick).toBe(true)
    const alone1 = controllerOn(state({ sessions: [] }))
    arrive(alone1, alone)
    expect(alone1.state.machinePick).toBeFalsy()
  })

  test('a tap on a machine shows its sessions, cursor on the first', () => {
    const c = controllerOn(state({ machinePick: true, machineCursor: 0 }))
    c.swipeDown()
    expect(c.state.machineCursor).toBe(1)
    c.tap()
    expect(c.state.machinePick).toBe(false)
    expect(c.state.sessionIndex).toBe(2)
    expect(c.state.selectedPaneId).toBeUndefined()
    expect(c.state.mode).toBe('session_list')
  })

  test('a double-tap on the session list goes up to the machines, at the machine it was on', () => {
    const c = controllerOn(state({ sessionIndex: 4 }))
    c.doubleTap()
    expect(c.state.machinePick).toBe(true)
    expect(c.state.machineCursor).toBe(2)
  })

  test('a double-tap on the machines is the way out, and so is one on a list with no machines', () => {
    const exits: number[] = []
    controllerOn(state({ machinePick: true }), exits).doubleTap()
    expect(exits).toHaveLength(1)
    controllerOn(state({ sessions: alone }), exits).doubleTap()
    expect(exits).toHaveLength(2)
  })

  test('coming back from a conversation lands on that session\'s machine, not on the machines', () => {
    // A question can jump straight from the machine screen into a
    // conversation on another machine; the way back is one level up.
    const c = controllerOn(state({ machinePick: true, mode: 'conversation', sessionIndex: 4 }))
    c.doubleTap()
    expect(c.state.mode).toBe('session_list')
    expect(c.state.machinePick).toBe(false)
    expect(listRowsFor(c.state).map((r) => r.sessionIndex)).toEqual([4])
  })

  test('the notices row is reachable from the machines too', () => {
    const c = controllerOn(state({
      machinePick: true, machineCursor: 0,
      relayInfo: [{ id: 'i1', kind: 'info', sessionId: 'w1', text: 'done', createdAt: 1 } as never],
    }))
    c.swipeUp()
    expect(c.state.listOnNotifications).toBe(true)
    c.swipeDown()
    expect(c.state.listOnNotifications).toBe(false)
    expect(c.state.machineCursor).toBe(0)
  })
})
