// One socket at a time.
//
// `onForegroundEnter` reconnects on the assumption that the socket died while
// the app slept. When it had not, `connect()` overwrote `this.ws` and left the
// previous socket open — and only the newest is ever pinged, because
// `startPing` clears the timer before setting it. The abandoned one went quiet,
// the server cut it as a zombie sixty seconds later, its `onclose` scheduled a
// reconnect, and that reconnect abandoned whichever socket was current by then.
//
// Measured on 2026-07-31: nineteen opens and sixteen ping timeouts in twenty
// minutes, against a run that was healthy throughout — no stalls, no refused
// writes, forty-five minutes old. Each of those closes dropped the relay
// subscription, so notifications had a hole in them roughly once a minute for
// the life of every run.

import { describe, expect, test } from 'bun:test'
import { WsClient } from '../ws-client.ts'
import { setBaseUrl } from '../api.ts'

// A base URL, so `connect()` never falls through to `location` — there is no
// document here and the socket's address is not what is being tested.
setBaseUrl('https://example.test')

/** A stand-in for the platform WebSocket that records what happened to it. */
class FakeSocket {
  static made: FakeSocket[] = []
  readyState = 0
  closed = false
  handlersCleared = false
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.made.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.handlersCleared = this.onclose === null
    // A real close fires the handler. If the client left it attached, this is
    // where the extra reconnect comes from.
    this.onclose?.()
  }
}

function client(): WsClient {
  FakeSocket.made = []
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
  ;(FakeSocket as unknown as { OPEN: number }).OPEN = 1
  return new WsClient({ onSessions: () => {}, onReady: () => {}, onError: () => {} } as never)
}

describe('connecting again does not leave the old socket open', () => {
  test('the previous socket is closed', () => {
    const ws = client()
    ws.connect()
    const first = FakeSocket.made[0]
    ws.connect()
    expect(first.closed).toBe(true)
    expect(FakeSocket.made).toHaveLength(2)
    ws.close()
  })

  test('its handlers come off before it is closed', () => {
    // Otherwise the deliberate close looks like one the network did, schedules
    // a reconnect, and produces a third socket for the one being replaced.
    const ws = client()
    ws.connect()
    const first = FakeSocket.made[0]
    ws.connect()
    expect(first.handlersCleared).toBe(true)
    expect(FakeSocket.made).toHaveLength(2)
    ws.close()
  })

  test('ten reconnects leave one socket, not ten', () => {
    const ws = client()
    for (let i = 0; i < 10; i++) ws.connect()
    const open = FakeSocket.made.filter((s) => !s.closed)
    expect(open).toHaveLength(1)
    ws.close()
  })

  test('closing for good closes the live one too', () => {
    const ws = client()
    ws.connect()
    ws.close()
    expect(FakeSocket.made.every((s) => s.closed)).toBe(true)
  })

  test('a foreground re-entry mid-life does not double up', () => {
    // The exact path: the app comes back, assumes its socket is gone, and asks
    // for another. It is allowed to — it just must not keep both.
    const ws = client()
    ws.connect()
    FakeSocket.made[0].readyState = 1
    ws.connect()
    expect(FakeSocket.made.filter((s) => !s.closed)).toHaveLength(1)
    ws.close()
  })
})
