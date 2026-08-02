// Closing itself when the server is gone for good.
//
// The client reconnects every three seconds and used to do so forever. For a
// Wi-Fi blip, a tailnet reconnect or a server restarted for a release that is
// exactly right — all of those come back in seconds. For a server that is not
// coming back, or a wearer who walked away from it, it turns the run into the
// shape submission guidance rejects: a WebView holding a page container, a
// microphone and a clock, showing whatever the screen said when the connection
// went, retrying until the host happens to kill it.
//
// So an unbroken run of failures long enough to rule out anything benign ends
// the run instead. It says so on the panel first: a WebView that simply
// disappears is indistinguishable from one the host killed, which is the
// failure the wearer has been living with all day, and the message is the whole
// difference between "it crashed again" and "it could not reach the server".

import { describe, expect, test } from 'bun:test'
import { GlassesController } from '../controller.ts'
import { screenText } from '../display.ts'
import { WsClient, GIVE_UP_AFTER_MS } from '../ws-client.ts'
import type { AppState } from '../display.ts'

// Supplied by `define` in vite.config.ts, so under `bun test` it has to be put
// there by hand — the closing screen names the product in its instructions.
;(globalThis as unknown as { __PRODUCT_NAME__: string }).__PRODUCT_NAME__ = 'Hrdle'

const TRIES = Math.round(GIVE_UP_AFTER_MS / 3000)

/** Drive one failed attempt without waiting three seconds for it. Every failure
 *  path in the client funnels through `scheduleReconnect`, so this is the same
 *  route a dropped socket takes. */
function failOnce(ws: WsClient): void {
  const inner = ws as unknown as { reconnectTimer: unknown; scheduleReconnect(): void }
  inner.reconnectTimer = null
  inner.scheduleReconnect()
}

function client(onGiveUp: () => void): WsClient {
  return new WsClient({
    onSessions: () => {},
    onReady: () => {},
    onError: () => {},
    onGiveUp,
  } as never)
}

describe('the client stops trying eventually', () => {
  test('it does not give up while the count is still short', () => {
    let gaveUp = 0
    const ws = client(() => gaveUp++)
    for (let i = 0; i < TRIES - 1; i++) failOnce(ws)
    expect(gaveUp).toBe(0)
    ws.close()
  })

  test('it gives up on the attempt that reaches the threshold', () => {
    let gaveUp = 0
    const ws = client(() => gaveUp++)
    for (let i = 0; i < TRIES; i++) failOnce(ws)
    expect(gaveUp).toBe(1)
    ws.close()
  })

  test('once it has given up it stops scheduling anything', () => {
    // Otherwise the run keeps a three-second clock alive for a socket it has
    // already decided not to open, which is most of what giving up was for.
    let gaveUp = 0
    const ws = client(() => gaveUp++)
    for (let i = 0; i < TRIES + 20; i++) failOnce(ws)
    expect(gaveUp).toBe(1)
    expect((ws as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull()
    ws.close()
  })

  test('five minutes is far outside anything a blip or a restart takes', () => {
    // The number is the point of the design, so it is asserted rather than
    // left to whatever the constant happens to say.
    expect(GIVE_UP_AFTER_MS).toBeGreaterThanOrEqual(3 * 60_000)
    expect(TRIES).toBeGreaterThan(50)
  })
})

function state(over: Partial<AppState> = {}): AppState {
  return {
    mode: 'session_list',
    sessions: [],
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

describe('the panel says why before it goes', () => {
  test('the closing screen replaces whatever mode was showing', () => {
    const body = screenText(state({ fatal: 'offline' })).body
    expect(body).toContain('Cannot reach the server')
    expect(body).toContain('Closing')
  })

  test('it outranks every mode, not just the list', () => {
    // None of them are true any more — the conversation behind it is whatever
    // arrived before the connection went.
    for (const mode of ['session_list', 'conversation', 'choice', 'voice', 'overlay'] as const) {
      expect(screenText(state({ mode, fatal: 'offline' })).body).toContain('Cannot reach the server')
    }
  })

  test('it quotes the same number the client waits', () => {
    const minutes = Math.round(GIVE_UP_AFTER_MS / 60_000)
    expect(screenText(state({ fatal: 'offline' })).body).toContain(`${minutes} minutes`)
  })

  test('no footer, because nothing it could offer would work', () => {
    const { footer, headerless } = screenText(state({ fatal: 'offline' }))
    expect(footer).toBe('')
    expect(headerless).toBe(true)
  })

  test('an ordinary state is untouched', () => {
    expect(screenText(state()).body).not.toContain('Cannot reach the server')
  })
})

function stubPlatform(log: string[]) {
  return {
    onDevice: true,
    render: () => log.push('render'),
    renderHeader: () => {},
    startMicCapture: async () => false,
    stopMicCapture: async () => {
      log.push('mic off')
    },
    transcribeAudio: async () => '',
    saveState: () => {},
    loadState: async () => null,
    requestExit: () => log.push('requestExit'),
    exitNow: () => log.push('exitNow'),
    onForegroundRegained: () => {},
  }
}

function gaveUp(c: GlassesController): void {
  ;(c as unknown as { onWsGaveUp(): void }).onWsGaveUp()
}

describe('the run closes itself after the message', () => {
  test('the message goes up first and the exit waits', () => {
    const log: string[] = []
    const c = new GlassesController(stubPlatform(log) as never)
    gaveUp(c)
    expect(c.state.fatal).toBe('offline')
    expect(log).toContain('render')
    // Not yet: the whole point of the delay is that the wearer gets to read it.
    expect(log).not.toContain('exitNow')
    ;(c as unknown as { shutdown(): void }).shutdown()
  })

  test('a host exit inside the delay cancels the close', () => {
    // The host takes runs down without warning all day. If it does so while the
    // message is up, the timer is holding a run that no longer exists.
    const log: string[] = []
    const c = new GlassesController(stubPlatform(log) as never)
    gaveUp(c)
    c.onHostExit('system')
    expect((c as unknown as { exitTimer: unknown }).exitTimer).toBeNull()
  })

  test('giving up twice does not queue two closes', () => {
    const log: string[] = []
    const c = new GlassesController(stubPlatform(log) as never)
    gaveUp(c)
    const first = (c as unknown as { exitTimer: unknown }).exitTimer
    gaveUp(c)
    expect((c as unknown as { exitTimer: unknown }).exitTimer).toBe(first)
    ;(c as unknown as { shutdown(): void }).shutdown()
  })
})
