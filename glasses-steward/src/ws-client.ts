// The live connection: what the steward writes, and the one raw thing this app
// still reads.
//
// Three subscriptions on one socket, and they are not the same kind of thing:
//
//   subscribe-steward   the thread, every session's line, every session's
//                       turns. This is what the app is made of
//   subscribe           a pane's terminal, for direct mode alone
//   (none)              `sessions-updated` arrives on every mux connection
//                       without asking, which is where session names come from
//
// Deliberately NOT `subscribe-glasses-relay`. That is v1's channel - blocked
// detection, scraped choices, an agent's own `hrdle glasses` note - and this
// app shows none of it. See the two-apps note in README.md: not subscribing is
// also what keeps this app from claiming the wearer's attention while the other
// one has it.

import { getBaseUrl } from './api.ts'
import type { Session, StewardSessionLine, StewardThreadItem, StewardTurn } from './types.ts'

export interface WsCallbacks {
  onSessionsUpdated: (sessions: Session[]) => void
  onStewardSnapshot: (thread: StewardThreadItem[], lines: StewardSessionLine[]) => void
  onStewardThread: (item: StewardThreadItem) => void
  onStewardLine: (line: StewardSessionLine) => void
  onStewardTurns: (sessionId: string, turns: StewardTurn[]) => void
  onStewardSessionRemoved: (sessionId: string) => void
  /** Direct mode's pane text, already stripped of escape sequences. */
  onTerminalOutput: (sessionId: string, paneId: string, text: string) => void
  onReady: () => void
  /** Unreachable for long enough that retrying costs more than it can buy. */
  onGiveUp?: () => void
}

// Well inside the server's 60s ping timeout, with room for a dropped one.
const PING_INTERVAL_MS = 15_000
const RECONNECT_DELAY_MS = 3000

/**
 * How long the app keeps trying before it closes itself.
 *
 * A WebView holding a page container, a microphone and a clock, showing a
 * screen from whenever the connection went, is exactly the shape submission
 * guidance rejects ("Lingering webviews inside the Even Realities App"). Five
 * minutes is far outside anything benign: a Wi-Fi blip, a tailnet reconnect or
 * a release restart all recover in seconds.
 */
export const GIVE_UP_AFTER_MS = 5 * 60_000
const GIVE_UP_AFTER_TRIES = Math.round(GIVE_UP_AFTER_MS / RECONNECT_DELAY_MS)

/** Lines of a pane kept for direct mode. Enough to page back a few screens. */
const TERMINAL_LINES = 60

/**
 * Strip ANSI escape codes, and fold box-drawing and bullet characters onto
 * ASCII the panel is sure of.
 *
 * Copied from the other app, including the part that matters: it must NOT end
 * by deleting non-ASCII, which threw away all Japanese. Renderability is
 * `stripUnrenderable()` in metrics.ts, which is where that judgement belongs.
 */
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[●◆■□▪▫]/g, '*')
    .replace(/[─━═]/g, '-')
    .replace(/[│┃║]/g, '|')
    .replace(/[╭╮┌┐]/g, '+')
    .replace(/[╰╯└┘]/g, '+')
    .replace(/[├┤┬┴┼]/g, '+')
    .replace(/[▶▸►→⟶➜]/g, '>')
    .replace(/[◀◂◄←⟵]/g, '<')
    .replace(/[▲▴△]/g, '^')
    .replace(/[▼▾▽]/g, 'v')
    .replace(/[⎿⌐⌙]/g, '|')
    .replace(/[✶✦✧★☆]/g, '*')
    .replace(/[❯›»❭❱⟩‣▸]/g, '>')
    .replace(/ /g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

export class WsClient {
  private ws: WebSocket | null = null
  private callbacks: WsCallbacks
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /** Consecutive failed attempts. An opened socket clears it, so only an
   *  unbroken run counts towards giving up. */
  private failures = 0
  /** Re-sent on every reconnect: a new socket is a new server-side session
   *  with no subscriptions at all. */
  private stewardSubscribed = false
  private subscribedSession: string | null = null
  private screenPublished = false
  private closed = false

  private terminalBuffers = new Map<string, string[]>()
  private lastSessions: Session[] = []

  constructor(callbacks: WsCallbacks) {
    this.callbacks = callbacks
  }

  connect(): void {
    if (this.closed) return
    // Whatever was here is replaced now rather than left open with nothing
    // pinging it - the server cuts an unpinged socket after 60s, and a
    // reconnect that abandons its predecessor produces two.
    this.discardSocket()
    const base = getBaseUrl() || location.origin
    const wsBase = base.startsWith('http')
      ? base.replace(/^http/, 'ws')
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`

    try {
      this.ws = new WebSocket(`${wsBase}/ws/mux`)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.failures = 0
      this.startPing()
      if (this.stewardSubscribed) this.send({ type: 'subscribe-steward' })
      if (this.subscribedSession) this.send({ type: 'subscribe', sessionId: this.subscribedSession })
      this.callbacks.onReady()
    }

    this.ws.onmessage = (ev) => this.handleMessage(ev.data as string)

    this.ws.onclose = () => {
      this.stopPing()
      this.scheduleReconnect()
    }
  }

  private handleMessage(data: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }

    switch (msg.type) {
      case 'sessions-updated':
        this.lastSessions = (msg.sessions as Session[]) ?? []
        this.callbacks.onSessionsUpdated(this.lastSessions)
        return
      case 'steward-snapshot':
        this.callbacks.onStewardSnapshot(
          (msg.thread as StewardThreadItem[]) ?? [],
          (msg.lines as StewardSessionLine[]) ?? [],
        )
        return
      case 'steward-thread':
        this.callbacks.onStewardThread(msg.item as StewardThreadItem)
        return
      case 'steward-line':
        this.callbacks.onStewardLine(msg.line as StewardSessionLine)
        return
      case 'steward-turns':
        this.callbacks.onStewardTurns(msg.sessionId as string, (msg.turns as StewardTurn[]) ?? [])
        return
      case 'steward-session-removed':
        this.callbacks.onStewardSessionRemoved(msg.sessionId as string)
        return
      case 'subscribed': {
        // The server sends a viewport on subscribe; ask explicitly too, in case
        // the pane we want is not the one it defaulted to.
        const sessionId = msg.sessionId as string | undefined
        if (sessionId) this.requestViewport(sessionId)
        return
      }
      case 'viewport': {
        const viewport = msg.viewport as { paneId: string; lines: string[] } | undefined
        if (viewport && typeof msg.sessionId === 'string') {
          this.applyViewport(msg.sessionId, viewport)
        }
        return
      }
      default:
        return
    }
  }

  private applyViewport(sessionId: string, viewport: { paneId: string; lines: string[] }): void {
    const lines = viewport.lines.map(stripAnsi).filter((l) => l.trim().length > 0)
    this.terminalBuffers.set(`${sessionId}:${viewport.paneId}`, lines.slice(-TERMINAL_LINES))
    this.callbacks.onTerminalOutput(sessionId, viewport.paneId, this.getTerminalText(sessionId))
  }

  /** Everything the steward writes, on one subscription: the overview needs the
   *  thread, every line and every session's turns at once. */
  subscribeSteward(): void {
    this.stewardSubscribed = true
    this.send({ type: 'subscribe-steward' })
  }

  /** A pane's terminal, for direct mode alone. Dropped on the way back up, so
   *  reading a summary costs no pane subscription at all. */
  subscribeSession(sessionId: string): void {
    if (this.subscribedSession === sessionId) return
    if (this.subscribedSession) this.send({ type: 'unsubscribe', sessionId: this.subscribedSession })
    this.subscribedSession = sessionId
    this.send({ type: 'subscribe', sessionId })
  }

  unsubscribeSession(): void {
    if (!this.subscribedSession) return
    this.send({ type: 'unsubscribe', sessionId: this.subscribedSession })
    this.subscribedSession = null
  }

  requestViewport(sessionId: string, paneId?: string): void {
    const target = paneId || this.activePaneId(sessionId) || '%0'
    this.send({ type: 'request-viewport', sessionId, paneId: target, offset: 0 })
  }

  getTerminalText(sessionId: string): string {
    for (const [key, buffer] of this.terminalBuffers) {
      if (key.startsWith(`${sessionId}:`)) return buffer.join('\n')
    }
    return ''
  }

  /**
   * Publish the panel's three strings.
   *
   * Not decoration: `hrdle steward screen` answers with the last frame
   * published here, so this is how the steward knows what its owner is looking
   * at - whether the question it asked is on screen, whether they are mid-
   * sentence in direct mode. An app that does not publish is invisible to the
   * agent that writes it.
   *
   * Device only. A simulator frame would tell the steward a wearer is reading
   * something when nobody is.
   */
  publishScreen(screen: Record<string, unknown>): void {
    this.screenPublished = true
    this.send({ type: 'glasses-screen', screen })
  }

  hasPublished(): boolean {
    return this.screenPublished
  }

  getState(): string {
    if (!this.ws) return 'null'
    return ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][this.ws.readyState] || String(this.ws.readyState)
  }

  private activePaneId(sessionId: string): string | null {
    const session = this.lastSessions.find((s) => s.id === sessionId)
    if (!session?.panes?.length) return null
    return session.panes.find((p) => p.isActive)?.paneId || session.panes[0]?.paneId || null
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private startPing(): void {
    this.stopPing()
    // sessionId is "" because the ping is connection-level, which the server's
    // handler allows. Without it the socket is cut and rebuilt every 90s for
    // the life of the app, losing a steward push on each gap.
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping', sessionId: '', timestamp: Date.now() })
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    this.failures++
    if (this.failures >= GIVE_UP_AFTER_TRIES) {
      // `closed` rather than a flag of its own: giving up means the same thing
      // to every path here as being closed does.
      this.closed = true
      this.callbacks.onGiveUp?.()
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, RECONNECT_DELAY_MS)
  }

  /** Close for good. The handlers come off first, so the close does not look
   *  like one the network did and schedule a reconnect. */
  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.discardSocket()
  }

  private discardSocket(): void {
    this.stopPing()
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    try {
      ws.close()
    } catch {
      /* already gone */
    }
  }
}
