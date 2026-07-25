import { getBaseUrl } from './api.ts'
import type { Session, GlassesRelayItem } from './types.ts'

export interface WsCallbacks {
  onSessionsUpdated: (sessions: Session[]) => void
  onTerminalOutput: (sessionId: string, paneId: string, text: string) => void
  onReady: () => void
  onError: (err: string) => void
  // Glasses relay channel (#504). Only received while subscribed via
  // subscribeGlassesRelay().
  onRelaySnapshot?: (items: GlassesRelayItem[]) => void
  onRelayUpsert?: (item: GlassesRelayItem) => void
  onRelayRemove?: (id: string) => void
}

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

export class CcHubWsClient {
  private ws: WebSocket | null = null
  private callbacks: WsCallbacks
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private subscribedSession: string | null = null
  // Glasses relay subscription is connection-scoped (no sessionId); re-sent on
  // every (re)connect while this flag is set (#504).
  private relaySubscribed = false

  // Buffer of last N lines per session
  private terminalBuffers = new Map<string, string[]>()
  private maxLines = 30
  private lastSessions: Session[] | null = null

  constructor(callbacks: WsCallbacks) {
    this.callbacks = callbacks
  }

  connect(): void {
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
      // Re-establish the relay subscription before onReady so the server's
      // snapshot arrives around the same time as session re-subscribes.
      if (this.relaySubscribed) {
        this.send({ type: 'subscribe-glasses-relay' })
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
        this.callbacks.onSessionsUpdated(msg.sessions)
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
  subscribeGlassesRelay(): void {
    this.relaySubscribed = true
    this.send({ type: 'subscribe-glasses-relay' })
  }

  unsubscribeGlassesRelay(): void {
    this.relaySubscribed = false
    this.send({ type: 'unsubscribe-glasses-relay' })
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 3000)
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }
}
