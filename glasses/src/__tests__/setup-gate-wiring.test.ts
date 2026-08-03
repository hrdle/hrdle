// The four gestures on the screen a wearer sees before a server exists.
//
// This seam shipped broken twice, both times as one line, both times because
// nothing could reach it: it was inside an async function, behind a branch
// that only runs on an unconfigured device.
//
//   v0.0.39 — wired a way out and no way around: tap and swipe went nowhere.
//   v0.0.40 — wired a way into the demo and left the demo's own gestures
//             going to a noop, so it drew a list and ignored the ring.
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
    // The whole of #148: an unconfigured app the reviewer could not close.
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
