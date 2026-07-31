import { getBaseUrl } from './api.ts'
import type { Session, GlassesRelayItem, ClientFocus, GlassesScreen } from './types.ts'

export interface WsCallbacks {
  /** `focus` is the session the phone/tablet in the user's hand is
   *  showing; undefined when every client is hidden. */
  onSessionsUpdated: (sessions: Session[], focus?: ClientFocus) => void
  onTerminalOutput: (sessionId: string, paneId: string, text: string) => void
  onReady: () => void
  onError: (err: string) => void
  // Glasses relay channel (#504). Only received while subscribed via
  // subscribeGlassesRelay().
  onRelaySnapshot?: (items: GlassesRelayItem[]) => void
  onRelayUpsert?: (item: GlassesRelayItem) => void
  onRelayRemove?: (id: string) => void
  /** Screen mirror (demo). `null` = no device publishing / publisher gone. */
  onGlassesScreen?: (screen: GlassesScreen | null) => void
  /** A newer run of the app has connected; this one is the ghost the host left
   *  behind and should let go of everything. `by` is the newcomer's id. */
  onSuperseded?: (by: string) => void
  /** The server has been unreachable long enough that retrying is no longer
   *  worth the resources it costs. Nothing will be attempted after this. */
  onGiveUp?: () => void
}

// Well inside the server's 60s ping timeout, with room for a dropped one.
const PING_INTERVAL_MS = 15_000

const RECONNECT_DELAY_MS = 3000

/**
 * How long the app keeps trying before it closes itself.
 *
 * Retrying forever is what a transient drop needs and what an abandoned run
 * turns into: a WebView holding a page container, a microphone and a clock,
 * showing a screen from whenever the connection went, reconnecting every three
 * seconds for as long as the host leaves it there. Submission guidance rejects
 * exactly that shape ("Lingering webviews inside the Even Realities App").
 *
 * Five minutes is chosen to be far outside anything benign. A Wi-Fi blip, a
 * tailnet reconnect, or the server being restarted for a release all recover in
 * seconds — a hundred consecutive failures is a server that is not coming back
 * on its own, or a wearer who walked away from it.
 */
export const GIVE_UP_AFTER_MS = 5 * 60_000
const GIVE_UP_AFTER_TRIES = Math.round(GIVE_UP_AFTER_MS / RECONNECT_DELAY_MS)

// Strip ANSI escape codes, control sequences, and non-ASCII for G2 display
function stripAnsi(str: string): string {
  return str
    // CSI sequences: ESC[ ... letter (includes 256-color, RGB, etc)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // OSC sequences: ESC] ... BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // ESC followed by single char
    .replace(/\x1b[^[\]]/g, '')
    // Carriage return cleanup
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Replace common Unicode symbols with ASCII equivalents
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
    .replace(/[❯❭❱⟩]/g, '>')
    .replace(/\u00a0/g, ' ')  // non-breaking space
    // Remove remaining non-ASCII (keep basic printable + newline + tab)
    .replace(/[^\x20-\x7e\n\t]/g, '')
}

export class WsClient {
  private ws: WebSocket | null = null
  private callbacks: WsCallbacks
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Consecutive failed attempts. Reset by a socket that opens, so only an
   *  unbroken run of them counts towards giving up. */
  private failures = 0
  // The server drops connections that go 60s without a ping (#236). Every
  // other client sends one; this one did not, so it was being cut and
  // reconnected on a 90s cycle for its whole life.
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private subscribedSession: string | null = null
  // Glasses relay subscription is connection-scoped (no sessionId); re-sent on
  // every (re)connect while this flag is set (#504).
  private relaySubscribed = false
  private onDevice = true
  /** Which run of the app this is; re-sent on every reconnect so the server's
   *  view of who is current survives a dropped socket. */
  private instanceId: string | undefined
  private screenSubscribed = false
  /** Set by `close()`. Refuses every later connect, including the automatic
   *  one, so a socket closed on the way out stays closed. */
  private closed = false

  // Buffer of last N lines per session
  private terminalBuffers = new Map<string, string[]>()
  private maxLines = 30
  private lastSessions: Session[] | null = null

  constructor(callbacks: WsCallbacks) {
    this.callbacks = callbacks
  }

  connect(): void {
    if (this.closed) return
    const base = getBaseUrl() || location.origin
    const wsBase = base.startsWith('http') ? base.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
    const wsUrl = wsBase + '/ws/mux'
    console.log('[ws] connecting to', wsUrl)

    try {
      this.ws = new WebSocket(wsUrl)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      console.log('[ws] connected')
      // Reaching the server is what makes the run of failures a blip rather
      // than an absence, so only an open socket clears it.
      this.failures = 0
      this.startPing()
      // Re-establish the relay subscription before onReady so the server's
      // snapshot arrives around the same time as session re-subscribes.
      if (this.relaySubscribed) {
        this.send({
          type: 'subscribe-glasses-relay',
          onDevice: this.onDevice,
          instanceId: this.instanceId,
        })
      }
      if (this.screenSubscribed) {
        this.send({ type: 'subscribe-glasses-screen' })
      }
      this.callbacks.onReady()
    }

    this.ws.onmessage = (ev) => {
      const preview = (ev.data as string).slice(0, 120)
      console.log('[ws] json:', preview)
      this.handleJsonMessage(ev.data as string)
    }

    this.ws.onclose = () => {
      console.log('[ws] closed')
      this.stopPing()
      // The reconnected socket is a brand-new server session with no
      // subscriptions. Reset our local view so onReady's subscribe() sends
      // a fresh 'subscribe' instead of the early-return dedup. #265
      this.subscribedSession = null
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.callbacks.onError('WebSocket error')
    }
  }

  private handleJsonMessage(data: string): void {
    try {
      const msg = JSON.parse(data)
      if (msg.type === 'sessions-updated') {
        this.lastSessions = msg.sessions
        this.callbacks.onSessionsUpdated(msg.sessions, msg.focus as ClientFocus | undefined)
      } else if (msg.type === 'subscribed' && msg.sessionId) {
        // Server emits an initial viewport on subscribe; ask explicitly too
        // so we get one even if our active pane differs from the default.
        const targetPane = this.getActivePaneId(msg.sessionId) || '%0'
        console.log('[ws] subscribed to', msg.sessionId, '— requesting viewport for', targetPane)
        this.send({ type: 'request-viewport', sessionId: msg.sessionId, paneId: targetPane, offset: 0 })
      } else if (msg.type === 'viewport' && msg.sessionId && msg.viewport) {
        this.applyViewport(msg.sessionId, msg.viewport)
      } else if (msg.type === 'glasses-relay-snapshot' && Array.isArray(msg.items)) {
        this.callbacks.onRelaySnapshot?.(msg.items as GlassesRelayItem[])
      } else if (msg.type === 'glasses-relay' && msg.item) {
        this.callbacks.onRelayUpsert?.(msg.item as GlassesRelayItem)
      } else if (msg.type === 'glasses-relay-remove' && typeof msg.id === 'string') {
        this.callbacks.onRelayRemove?.(msg.id as string)
      } else if (msg.type === 'glasses-screen') {
        this.callbacks.onGlassesScreen?.((msg.screen ?? null) as GlassesScreen | null)
      } else if (msg.type === 'glasses-superseded') {
        this.callbacks.onSuperseded?.(String(msg.by ?? '?'))
      }
    } catch { /* ignore */ }
  }

  private applyViewport(
    sessionId: string,
    viewport: { paneId: string; lines: string[] },
  ): void {
    const cleanLines = viewport.lines
      .map((l) => stripAnsi(l))
      .filter((l) => l.trim().length > 0)
    const key = `${sessionId}:${viewport.paneId}`
    this.terminalBuffers.set(key, cleanLines.slice(-this.maxLines))
    this.callbacks.onTerminalOutput(
      sessionId,
      viewport.paneId,
      this.getTerminalText(sessionId),
    )
  }

  subscribe(sessionId: string): void {
    if (this.subscribedSession === sessionId) return
    if (this.subscribedSession) {
      this.unsubscribe(this.subscribedSession)
    }
    this.subscribedSession = sessionId
    this.send({ type: 'subscribe', sessionId })
  }

  unsubscribe(sessionId: string): void {
    this.send({ type: 'unsubscribe', sessionId })
    if (this.subscribedSession === sessionId) {
      this.subscribedSession = null
    }
  }

  /** Mark this connection as "glasses present" (#504). The server gates relay
   *  assembly/sending on this subscription and answers with a snapshot of the
   *  current waiting/info items. Re-sent automatically on reconnect. */
  /** `onDevice` false = the browser simulator. It receives every relay item
   *  either way; the flag only stops a preview window from being taken as
   *  proof that the user was told, which would silence their browser push. */
  /** `instanceId` names this run of the app, so the server can retire the
   *  previous one — the host launches a new WebView without tearing down the old
   *  one, and neither instance can see the other from inside. */
  subscribeGlassesRelay(onDevice: boolean, instanceId?: string): void {
    this.relaySubscribed = true
    this.onDevice = onDevice
    this.instanceId = instanceId
    this.send({ type: 'subscribe-glasses-relay', onDevice, instanceId })
  }

  unsubscribeGlassesRelay(): void {
    this.relaySubscribed = false
    this.send({ type: 'unsubscribe-glasses-relay' })
  }

  /** Publish the screen the panel is showing, for demo mirrors. Only the
   *  device calls this — the simulator has no bridge and would otherwise echo
   *  its own frames back at itself. */
  publishScreen(screen: GlassesScreen): void {
    this.send({ type: 'glasses-screen', screen })
  }

  /** Late-bound because only the browser simulator listens, and it is built
   *  after the controller that owns this client. */
  setGlassesScreenHandler(fn: (screen: GlassesScreen | null) => void): void {
    this.callbacks.onGlassesScreen = fn
  }

  /** Watch the device's screen. The server replies with the retained frame, so
   *  a viewer joining mid-demo sees the current screen rather than a blank
   *  panel until the next render. */
  subscribeGlassesScreen(): void {
    this.screenSubscribed = true
    this.send({ type: 'subscribe-glasses-screen' })
  }

  unsubscribeGlassesScreen(): void {
    this.screenSubscribed = false
    this.send({ type: 'unsubscribe-glasses-screen' })
  }

  getTerminalText(sessionId: string): string {
    // Find any buffer matching this session
    for (const [key, buf] of this.terminalBuffers) {
      if (key.startsWith(`${sessionId}:`)) {
        return buf.join('\n')
      }
    }
    return ''
  }

  /** Extract numbered choices from terminal output (e.g. "1. Yes", "2. No") */
  getChoices(sessionId: string): string[] {
    const text = this.getTerminalText(sessionId)
    if (!text) return []
    const lines = text.split('\n')
    const choices: string[] = []
    // Look for numbered options like "  1. Yes", "> 1. Yes", or "❯ 1. Yes"
    // Claude Code uses ❯ as the cursor marker. Dot may be followed by zero or more spaces.
    for (const line of lines) {
      const match = line.match(/^\s*[❯>*]?\s*(\d+)\.\s*(.+)/)
      if (match) {
        choices.push(match[2].trim())
      }
    }
    return choices
  }

  getState(): string {
    if (!this.ws) return 'null'
    return ['CONNECTING','OPEN','CLOSING','CLOSED'][this.ws.readyState] || String(this.ws.readyState)
  }

  getSubscribed(): string | null {
    return this.subscribedSession
  }

  /** Request fresh terminal content and wait for the response */
  requestContentAndWait(sessionId: string, paneId?: string, timeoutMs = 3000): Promise<void> {
    const targetPane = paneId || this.getActivePaneId(sessionId) || '%0'
    return new Promise<void>((resolve) => {
      const key = `${sessionId}:${targetPane}`
      const before = this.terminalBuffers.get(key)
      const timer = setTimeout(resolve, timeoutMs)
      const check = () => {
        const after = this.terminalBuffers.get(key)
        if (after !== before) {
          clearTimeout(timer)
          resolve()
        }
      }
      // Poll briefly for buffer change after the viewport push arrives
      const interval = setInterval(check, 50)
      setTimeout(() => clearInterval(interval), timeoutMs)
      this.send({ type: 'request-viewport', sessionId, paneId: targetPane, offset: 0 })
    })
  }

  requestContent(sessionId: string, paneId?: string): void {
    const targetPane = paneId || this.getActivePaneId(sessionId) || '%0'
    this.send({ type: 'request-viewport', sessionId, paneId: targetPane, offset: 0 })
  }

  sendInput(sessionId: string, text: string, paneId?: string): void {
    const data = btoa(text)
    // Use specified paneId, or find the first active pane from sessions data
    const targetPane = paneId || this.getActivePaneId(sessionId) || '%0'
    this.send({ type: 'input', sessionId, paneId: targetPane, data })
  }

  private getActivePaneId(sessionId: string): string | null {
    // Find active pane from the last sessions-updated data
    const session = this.lastSessions?.find(s => s.id === sessionId)
    if (!session?.panes) return null
    const active = session.panes.find((p: { isActive?: boolean }) => p.isActive)
    return active?.paneId || session.panes[0]?.paneId || null
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Keepalive. The server closes a connection 60s after the last ping, so
   *  without this the socket dies and reconnects every 90s forever — the
   *  glasses lose relay pushes for the gap each time. sessionId is "" because
   *  the ping is connection-level, which the server's handler allows. */
  private startPing(): void {
    this.stopPing()
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
    // Every failure funnels through here — a constructor that threw, a close,
    // an error — so this is the one place the run of them can be counted.
    this.failures++
    if (this.failures >= GIVE_UP_AFTER_TRIES) {
      // `closed` rather than a separate flag: giving up means the same thing to
      // every other path here as being closed does, and it stops `connect()`
      // from being reached again by any of them.
      this.closed = true
      this.callbacks.onGiveUp?.()
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, RECONNECT_DELAY_MS)
  }

  /**
   * Close for good.
   *
   * This used to reconnect three seconds later. `ws.close()` fires `onclose`,
   * `onclose` schedules a reconnect, and nothing said not to — so the one caller
   * that matters, the host tearing the app down, got a socket back and with it
   * the `sessions-updated` pushes that keep the app drawing to a panel it no
   * longer owns. The handlers are detached before closing so the close is
   * silent, and `closed` refuses any later connect.
   */
  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
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
    } catch { /* already gone; nothing left to close */ }
  }
}
