// The four gestures on the screen a wearer sees before a server exists.
//
// This seam shipped broken twice, both times as one line, both times because
// nothing could reach it: it was inside an async function, behind a branch
// that only runs on an unconfigured device.
//
//   v0.0.39 — wired a way out and no way around: tap and swipe went nowhere.
//   v0.0.40 — wired a way into the demo and left the demo's own gestures
//             going to a noop, so it drew a list and ignored the ring.
//   v0.0.43 — closed the gate when the server address arrived and left the
//             demo running, so every live workspace carried the DEMO tail.
//
// Every one of those is a case here now.

import { describe, expect, test } from 'bun:test'
import { createSetupGate } from '../setup-gate.ts'
import type { SetupGateDeps } from '../setup-gate.ts'

function deps(): SetupGateDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    startDemo: () => calls.push('startDemo'),
    stopDemo: () => calls.push('stopDemo'),
    tap: () => calls.push('tap'),
    doubleTap: () => calls.push('doubleTap'),
    swipeUp: () => calls.push('swipeUp'),
    swipeDown: () => calls.push('swipeDown'),
    requestExit: () => calls.push('requestExit'),
    invalidatePanel: () => calls.push('invalidatePanel'),
    trace: () => {},
  }
}

describe('before the demo', () => {
  test('double-tap asks for the exit dialogue', () => {
    // An unconfigured app must still be closable.
    const d = deps()
    createSetupGate(d).onDoubleTap()
    expect(d.calls).toEqual(['requestExit'])
  })

  test('tap starts the demo, and forgets the panel first', () => {
    // Order matters: the guide was drawn behind updateDisplay's back, so the
    // record has to be dropped before anything is drawn over it.
    const d = deps()
    createSetupGate(d).onTap()
    expect(d.calls).toEqual(['invalidatePanel', 'startDemo'])
  })

  test('swipes do nothing on a screen with nothing to walk', () => {
    const d = deps()
    const gate = createSetupGate(d)
    gate.onSwipeUp()
    gate.onSwipeDown()
    expect(d.calls).toEqual([])
  })
})

describe('once the demo is up', () => {
  test('every gesture reaches the controller', () => {
    // v0.0.40 drew the list and then ignored all four of these.
    const d = deps()
    const gate = createSetupGate(d)
    gate.onTap()
    d.calls.length = 0
    gate.onSwipeUp()
    gate.onSwipeDown()
    gate.onTap()
    gate.onDoubleTap()
    expect(d.calls).toEqual(['swipeUp', 'swipeDown', 'tap', 'doubleTap'])
  })

  test('a second tap does not start it again', () => {
    const d = deps()
    const gate = createSetupGate(d)
    gate.onTap()
    gate.onTap()
    expect(d.calls.filter((c) => c === 'startDemo')).toHaveLength(1)
  })

  test('double-tap goes to the controller, not straight to the host', () => {
    // The controller decides: back out of a conversation, or ask for the exit
    // dialogue from its own root. The gate does not second-guess it.
    const d = deps()
    const gate = createSetupGate(d)
    gate.onTap()
    d.calls.length = 0
    gate.onDoubleTap()
    expect(d.calls).toEqual(['doubleTap'])
    expect(d.calls).not.toContain('requestExit')
  })

  test('it knows it is up', () => {
    const gate = createSetupGate(deps())
    expect(gate.inDemo()).toBe(false)
    gate.onTap()
    expect(gate.inDemo()).toBe(true)
  })
})

describe('when the address arrives', () => {
  test('closing takes the demo with it', () => {
    // `demo` is a flag on the state the real app draws from: left set, the
    // DEMO tail rides over live workspaces for the rest of the run.
    const d = deps()
    const gate = createSetupGate(d)
    gate.onTap()
    d.calls.length = 0
    gate.close()
    expect(d.calls).toEqual(['stopDemo'])
    expect(gate.inDemo()).toBe(false)
  })

  test('closing a gate nobody stepped through does nothing', () => {
    const d = deps()
    const gate = createSetupGate(d)
    gate.close()
    expect(d.calls).toEqual([])
  })

  test('a closed gate does not hand gestures to the controller', () => {
    // The real wiring owns the ring from here. Two handlers for one gesture is
    // how a tap both opens a workspace and starts a demo.
    const d = deps()
    const gate = createSetupGate(d)
    gate.onTap()
    gate.close()
    d.calls.length = 0
    gate.onTap()
    gate.onSwipeUp()
    gate.onDoubleTap()
    expect(d.calls).toEqual([])
  })
})
