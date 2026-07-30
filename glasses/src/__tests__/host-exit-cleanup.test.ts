// What the app releases when the host takes it down (#46).
//
// It used to release nothing. The exit event arrived, `saveResumePoint` ran, and
// then two interval clocks, a WebSocket that reconnected itself, an open
// microphone and a render queue carried on against a page container the host had
// already revoked — about one refused write a second, one recorded run still
// going 64 minutes later. Official submission guidance rejects exactly that
// ("Lingering webviews inside the Even Realities App are rejected").
//
// The measure on the device is that no log line carries a run's id after its
// `host exit`. These are the same claim made where it can be asserted.

import { afterEach, describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import { invalidatePanel, panelGaveUp, updateDisplay } from '../display.ts'
import { setBaseUrl } from '../api.ts'

function stubPlatform(log: string[]) {
  return {
    onDevice: true,
    render: () => log.push('render'),
    renderHeader: () => log.push('renderHeader'),
    startMicCapture: async () => {
      log.push('mic on')
      return true
    },
    stopMicCapture: async () => {
      log.push('mic off')
    },
    transcribeAudio: async () => '',
    saveState: () => log.push('saveState'),
    loadState: async () => null,
    requestExit: () => log.push('requestExit'),
    onForegroundRegained: () => {},
  }
}

/** A controller with its clocks and socket actually started, which is the state
 *  the cleanup has to undo. The base URL points at a closed port: the socket
 *  never opens, and nothing here depends on whether it does. */
function connected() {
  setBaseUrl('http://127.0.0.1:1')
  const log: string[] = []
  const c = new GlassesController(stubPlatform(log) as never)
  c.connect()
  return {
    c,
    log,
    timers: c as unknown as { spinnerTimer: unknown; autoTimer: unknown },
  }
}

describe('a host exit releases what the app took', () => {
  test('the two interval clocks are stopped', () => {
    // They were started with their ids discarded — "one timer for the life of
    // the app", taken literally enough that nothing could stop them.
    const { c, timers } = connected()
    expect(timers.spinnerTimer).not.toBeNull()
    expect(timers.autoTimer).not.toBeNull()
    c.onHostExit('system')
    expect(timers.spinnerTimer).toBeNull()
    expect(timers.autoTimer).toBeNull()
  })

  test('the socket is closed and stays closed', () => {
    // `close()` used to schedule a reconnect three seconds later: closing the
    // socket fires `onclose`, and `onclose` reconnects. The one caller that
    // matters is this one.
    const { c } = connected()
    c.onHostExit('system')
    expect(c.ws.getState()).toBe('null')
    c.ws.connect()
    expect(c.ws.getState()).toBe('null')
  })

  test('the microphone is closed', () => {
    // Unconditionally: `recording` tracks whether the PCM is being collected,
    // not whether the mic is open.
    const { c, log } = connected()
    c.onHostExit('system')
    expect(log).toContain('mic off')
  })

  test('the resume point is saved before anything is torn down', () => {
    const { c, log } = connected()
    c.onHostExit('system')
    expect(log.indexOf('saveState')).toBeGreaterThanOrEqual(0)
    expect(log.indexOf('saveState')).toBeLessThan(log.indexOf('mic off'))
  })

  test('nothing draws afterwards', async () => {
    // The clocks are stopped, but work already in flight comes back and asks
    // for a frame. `render` is the one door every draw goes through.
    const { c, log } = connected()
    c.onHostExit('system')
    log.length = 0
    c.tap()
    c.swipeUp()
    c.onForegroundEnter()
    ;(c as unknown as { onSessionsUpdated(s: unknown[]): void }).onSessionsUpdated([
      { id: 'a', name: 'work', state: 'idle', panes: [] },
    ])
    await Promise.resolve()
    expect(log).toEqual([])
  })

  test('a second exit event is harmless', () => {
    // The host has been seen sending one while the app was already leaving.
    const { c, log } = connected()
    c.onHostExit('system')
    log.length = 0
    c.onHostExit('abnormal')
    expect(log).toEqual([])
  })

  test('it reports itself as stopped', () => {
    const { c } = connected()
    expect(c.isStopped()).toBe(false)
    c.onHostExit('abnormal')
    expect(c.isStopped()).toBe(true)
  })
})

describe('a foreground exit closes the microphone', () => {
  test('an interrupted recording does not leave the mic open', async () => {
    // The PCM stops arriving when the glasses show something else, while
    // `recording` still claims otherwise — so the recording is abandoned rather
    // than left to resume into a screen that will never receive audio.
    const { c, log } = connected()
    const inner = c as unknown as { startVoice(t: unknown): Promise<void> }
    await inner.startVoice({ sessionId: 'a', paneId: '%1' })
    expect(log).toContain('mic on')
    log.length = 0
    c.onForegroundExit()
    await Promise.resolve()
    expect(log).toContain('mic off')
  })

  test('with no recording in progress it stays a save', () => {
    const { c, log } = connected()
    c.onForegroundExit()
    expect(log).toEqual(['saveState'])
  })
})

describe('a panel that refuses every write is given up on', () => {
  // The backstop for an exit event that never arrives — one recorded run
  // produced 541 refused writes in eight minutes without one, and another
  // started refusing before the exit event turned up.

  afterEach(() => {
    // The flag is module state; clearing it is what a foreground re-entry does.
    invalidatePanel()
  })

  /** A host that refuses everything, counting what it was asked to draw. */
  function refusingBridge() {
    let calls = 0
    const bridge = {
      textContainerUpgrade: () => {
        calls++
        return Promise.resolve(false)
      },
      rebuildPageContainer: () => {
        calls++
        return Promise.resolve(false)
      },
    }
    return { bridge: bridge as never, calls: () => calls }
  }

  const listState = (name: string) =>
    ({
      mode: 'session_list' as const,
      sessions: [{ id: 'a', name, state: 'idle' as const }],
      sessionIndex: 0,
      selectedPaneId: null,
      conversation: [],
      conversationOffset: 0,
      conversationPage: 0,
      conversationHasMore: false,
      conversationLoading: false,
      choiceIndex: 0,
      choiceOptions: [],
      relayWaiting: [],
      relayInfo: [],
      overlayItemId: null,
      spinnerTick: 0,
    }) as never

  test('drawing stops after a run of refusals', async () => {
    invalidatePanel()
    const { bridge, calls } = refusingBridge()
    for (let i = 0; i < 40; i++) await updateDisplay(bridge, listState(`n${i}`))
    expect(panelGaveUp()).toBe(true)
    const settled = calls()
    await updateDisplay(bridge, listState('again'))
    expect(calls()).toBe(settled)
  })

  test('a foreground re-entry gives the panel another chance', async () => {
    invalidatePanel()
    const { bridge } = refusingBridge()
    for (let i = 0; i < 40; i++) await updateDisplay(bridge, listState(`n${i}`))
    expect(panelGaveUp()).toBe(true)
    invalidatePanel()
    expect(panelGaveUp()).toBe(false)
    const accepting = {
      textContainerUpgrade: () => Promise.resolve(true),
      rebuildPageContainer: () => Promise.resolve(true),
    } as never
    await updateDisplay(accepting, listState('back'))
    expect(panelGaveUp()).toBe(false)
  })

  test('an accepted write clears the run', async () => {
    // Only a write that reached the panel proves it is still ours, and a few
    // scattered refusals must not add up to giving up.
    invalidatePanel()
    let refuse = true
    const flaky = {
      textContainerUpgrade: () => Promise.resolve(!refuse),
      rebuildPageContainer: () => Promise.resolve(true),
    } as never
    for (let i = 0; i < 40; i++) {
      refuse = i % 2 === 0
      await updateDisplay(flaky, listState(`n${i}`))
    }
    expect(panelGaveUp()).toBe(false)
  })
})
