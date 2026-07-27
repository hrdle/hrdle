// Glasses app controller (#504) — domain layer: the relay item queue drives
// the UI, and an explicit state machine maps ring actions to transitions.
//
// This is the SINGLE handler/domain implementation consumed by both the G2
// path (main.ts, real Even Hub bridge + mic) and the browser debug simulator
// (debug-ui.ts). Platform differences (rendering, mic, STT) are injected via
// GlassesPlatform; everything else — modes, transitions, relay flow, choice
// and voice reply routing — lives here exactly once.
//
// State machine modes:
//   session_list  session browsing (waiting count badge in header)
//   conversation  conversation tab; a waiting overlay banner heads the view
//   overlay       full-screen presentation of one waiting relay item
//   choice        answer a waiting item / TUI prompt with ring (arrow keys + Enter)
//   voice         free-text voice reply (mic → STT → prompt)
//
// Ring routing (input layer):
//   session_list: swipe=navigate  tap=open  doubleTap=overlay (when waiting)
//   conversation: swipe=page  tap=respond to top waiting item (jump when it
//                 belongs to another session) / legacy scrape / voice
//                 doubleTap=dismiss top waiting item, else back to list
//   overlay:      swipe=cycle waiting queue  tap=jump to item session
//                 (choice mode when the item has choices)  doubleTap=dismiss
//   choice:       swipe=arrow keys to the item's sessionId+paneId  tap=Enter
//                 doubleTap=cancel (item stays queued)
//   voice:        tap=stop→transcribe / send  doubleTap=cancel

import { getConversation, sendPrompt, sendPaneInput, dismissRelayItem } from './api.ts'
import { SPINNER_INTERVAL_MS, getTotalPagesAt, getMultiCountAt } from './display.ts'
import type { AppState } from './display.ts'
import { RelayQueue } from './relay-queue.ts'
import { CcHubWsClient } from './ws-client.ts'
import type { Session, ConversationMessage, GlassesRelayItem, ClientFocus } from './types.ts'

const INITIAL_LOAD_COUNT = 20
const LOAD_MORE_INCREMENT = 20
const CONV_REFRESH_INTERVAL = 3000

export type RingAction = 'tap' | 'doubleTap' | 'swipeUp' | 'swipeDown'

/** Platform capabilities the controller cannot provide itself. The G2 wires
 *  the real Even Hub bridge + mic; the debug simulator fakes them. */
export interface GlassesPlatform {
  /** Re-render the whole UI from the (mutated) state. */
  render(state: AppState): void
  /** Redraw only the header. The spinner changes nothing else, and on the
   *  device a full update sends three containers where one will do. */
  renderHeader(state: AppState): void
  /** Start mic capture. Returns false when audio is unavailable. */
  startMicCapture(): Promise<boolean>
  stopMicCapture(): Promise<void>
  /** Transcribe collected PCM into text. */
  transcribeAudio(pcm: Uint8Array): Promise<string>
}

/** Where a reply (choice keys / voice prompt) is routed. paneId targets the
 *  exact blocked pane in multi-pane workspaces (#504 replyTo routing). */
interface ReplyTarget {
  sessionId: string
  paneId?: string
  /** The relay item being answered. Auto items self-clear when herdr reports
   *  the pane unblocked; agent self-notes have no blocked epoch, so they are
   *  dropped explicitly on a successful reply (#504). */
  itemId?: string
}

/** Concatenate collected PCM chunks into one contiguous buffer. */
function concatPcm(chunks: Uint8Array[]): Uint8Array {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Uint8Array(len)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Merge consecutive assistant messages and filter out tool-result-only messages */
function filterConversation(msgs: ConversationMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = []
  for (const m of msgs) {
    // Skip tool result-only messages (output is heavily truncated)
    if (!m.content?.trim() && !m.toolUse?.length && m.toolResult?.length) continue

    // Merge assistant tool-use-only message with previous assistant text
    if (m.role === 'assistant' && !m.content?.trim() && m.toolUse?.length) {
      const prev = result[result.length - 1]
      if (prev?.role === 'assistant' && prev.content?.trim()) {
        prev.toolUse = [...(prev.toolUse || []), ...m.toolUse]
        continue
      }
    }

    result.push({ ...m })
  }
  return result
}

function initialState(): AppState {
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
  }
}

export class GlassesController {
  readonly state: AppState = initialState()
  readonly ws: CcHubWsClient
  private readonly platform: GlassesPlatform
  private readonly queue = new RelayQueue()

  private choiceTarget: ReplyTarget | null = null
  private voiceTarget: ReplyTarget | null = null
  private overlayReturnMode: 'session_list' | 'conversation' = 'session_list'

  private audioChunks: Uint8Array[] = []
  private recording = false
  private lastConvRefresh = 0

  constructor(platform: GlassesPlatform) {
    this.platform = platform
    this.ws = new CcHubWsClient({
      onSessionsUpdated: (sessions, focus) => this.onSessionsUpdated(sessions, focus),
      onTerminalOutput: () => this.maybeRefreshConversation(),
      onReady: () => this.onWsReady(),
      onError: () => {},
      onRelaySnapshot: (items) => this.onRelaySnapshot(items),
      onRelayUpsert: (item) => this.onRelayUpsert(item),
      onRelayRemove: (id) => this.onRelayRemove(id),
    })
  }

  /** Connect the WS and mark this connection as "glasses present" (#504). The
   *  relay subscription is (re)sent on every connect; the server answers with
   *  a snapshot, then pushes upserts/removals. */
  connect(): void {
    this.ws.subscribeGlassesRelay()
    this.ws.connect()
    // One timer for the life of the app rather than start/stop bookkeeping on
    // every state change. It costs nothing when nothing is working: the tick
    // returns before touching the display.
    setInterval(() => this.tickSpinner(), SPINNER_INTERVAL_MS)
  }

  /** Advance the working indicator, but only where it is being looked at and
   *  only while there is something to indicate. */
  private tickSpinner(): void {
    const st = this.state
    if (st.mode !== 'conversation') return
    if (this.currentSession()?.indicatorState !== 'processing') return
    st.spinnerTick = (st.spinnerTick ?? 0) + 1
    this.platform.renderHeader(st)
  }

  // ── Ring input (the single handler set shared by G2 and debug) ──

  tap(): void { void this.handle('tap') }
  doubleTap(): void { void this.handle('doubleTap') }
  swipeUp(): void { void this.handle('swipeUp') }
  swipeDown(): void { void this.handle('swipeDown') }

  onAudioData(pcm: Uint8Array): void {
    if (this.recording) this.audioChunks.push(pcm)
  }

  /** Explicit state machine dispatch: (mode, action) → transition. */
  private async handle(action: RingAction): Promise<void> {
    switch (this.state.mode) {
      case 'session_list': return this.onSessionListAction(action)
      case 'conversation': return this.onConversationAction(action)
      case 'overlay': return this.onOverlayAction(action)
      case 'choice': return this.onChoiceAction(action)
      case 'voice': return this.onVoiceAction(action)
    }
  }

  // ── session_list ──

  private async onSessionListAction(action: RingAction): Promise<void> {
    const st = this.state
    switch (action) {
      case 'swipeUp':
        if (st.sessionIndex > 0) st.sessionIndex--
        this.render()
        return
      case 'swipeDown':
        if (st.sessionIndex < st.sessions.length - 1) st.sessionIndex++
        this.render()
        return
      case 'tap': {
        const s = this.currentSession()
        if (!s) return
        this.ws.subscribe(s.id)
        st.mode = 'conversation'
        st.conversation = []
        st.conversationOffset = 0
        st.conversationPage = 0
        this.render()
        await this.loadConversation()
        this.render()
        return
      }
      case 'doubleTap':
        // Manual entry to the waiting overlay (auto-entry covers the rest).
        if (this.queue.topWaiting()) {
          this.enterOverlay()
          return
        }
        this.render()
        return
    }
  }

  // ── conversation ──

  private async onConversationAction(action: RingAction): Promise<void> {
    const st = this.state
    switch (action) {
      case 'swipeUp': {
        // Page up within message, then previous message(s)
        if (st.conversationPage > 0) {
          st.conversationPage--
        } else if (st.conversationOffset < st.conversation.length - 1) {
          const jump = getMultiCountAt(st.conversation, st.conversationOffset)
          st.conversationOffset = Math.min(st.conversation.length - 1, st.conversationOffset + jump)
          st.conversationPage = Math.max(0, this.currentMsgTotalPages() - 1)
        } else if (st.conversationHasMore && !st.conversationLoading) {
          // At oldest loaded message — fetch more. Offset is measured from the
          // newest, so existing messages keep their offsets after prepending.
          const loaded = await this.loadMoreConversation()
          if (loaded && st.conversationOffset < st.conversation.length - 1) {
            const jump = getMultiCountAt(st.conversation, st.conversationOffset)
            st.conversationOffset = Math.min(st.conversation.length - 1, st.conversationOffset + jump)
            st.conversationPage = Math.max(0, this.currentMsgTotalPages() - 1)
          }
        }
        this.render()
        return
      }
      case 'swipeDown': {
        // Page down within message, then next message(s)
        const totalPages = this.currentMsgTotalPages()
        if (st.conversationPage < totalPages - 1) {
          st.conversationPage++
        } else if (st.conversationOffset > 0) {
          const jump = getMultiCountAt(st.conversation, st.conversationOffset - 1)
          st.conversationOffset = Math.max(0, st.conversationOffset - jump)
          st.conversationPage = 0
        }
        this.render()
        return
      }
      case 'tap': {
        const top = this.queue.topWaiting()
        const cur = this.currentSession()
        if (top && cur && top.sessionId !== cur.id) {
          // Tap on the overlay banner: the waiting item belongs to another
          // session → jump to it (#504).
          await this.jumpToItem(top)
          return
        }
        if (top) {
          // Waiting item for the session being viewed → respond. Structured
          // relay choices win; terminal scraping is the fallback.
          if (top.choices?.length) {
            this.enterChoice(top.choices, { sessionId: top.sessionId, paneId: top.paneId, itemId: top.id })
            return
          }
          const scraped = await this.scrapeChoices(top.sessionId)
          if (scraped.length > 0) {
            this.enterChoice(scraped, { sessionId: top.sessionId, paneId: top.paneId, itemId: top.id })
            return
          }
          await this.startVoice({ sessionId: top.sessionId, paneId: top.paneId, itemId: top.id })
          return
        }
        // No relay items — legacy indicator flow (scrape, else voice).
        if (cur && isSessionWaiting(cur)) {
          const scraped = await this.scrapeChoices(cur.id)
          if (scraped.length > 0) {
            this.enterChoice(scraped, { sessionId: cur.id })
            return
          }
        }
        if (cur) await this.startVoice({ sessionId: cur.id })
        return
      }
      case 'doubleTap': {
        // Double-tap on the overlay banner = dismiss ("later / on PC").
        const top = this.queue.topWaiting()
        if (top) {
          await this.dismissItem(top)
          return
        }
        // Back out one level at a time. Having read some way into the history,
        // the way out is to the top of it — swiping all the way down again to
        // leave is the wrong amount of work. Only from the newest message does
        // the same gesture leave the session.
        if (st.conversationOffset > 0 || st.conversationPage > 0) {
          st.conversationOffset = 0
          st.conversationPage = 0
          this.render()
          // Live updates resume at the top, and whatever arrived while the
          // reader was back there should be waiting for them.
          await this.loadConversation()
          this.render()
          return
        }
        st.mode = 'session_list'
        this.render()
        return
      }
    }
  }

  // ── overlay ──

  private async onOverlayAction(action: RingAction): Promise<void> {
    const st = this.state
    const waiting = this.queue.waitingItems()
    const item = waiting.find((i) => i.id === st.overlayItemId) || waiting[0]
    switch (action) {
      case 'swipeUp':
      case 'swipeDown': {
        if (waiting.length < 2) return
        const idx = item ? waiting.indexOf(item) : 0
        const delta = action === 'swipeDown' ? 1 : -1
        st.overlayItemId = waiting[(idx + delta + waiting.length) % waiting.length].id
        this.render()
        return
      }
      case 'tap': {
        if (!item) {
          this.exitOverlay()
          return
        }
        // Jump to the item's session (subscribe + open conversation; choice
        // mode when the item carries structured choices).
        await this.jumpToItem(item)
        return
      }
      case 'doubleTap': {
        if (!item) {
          this.exitOverlay()
          return
        }
        await this.dismissItem(item)
        return
      }
    }
  }

  // ── choice ──

  private onChoiceAction(action: RingAction): Promise<void> {
    const st = this.state
    switch (action) {
      case 'swipeUp':
        this.sendChoiceKey('\x1b[A')
        if (st.choiceIndex > 0) st.choiceIndex--
        this.render()
        return Promise.resolve()
      case 'swipeDown':
        this.sendChoiceKey('\x1b[B')
        if (st.choiceIndex < st.choiceOptions.length - 1) st.choiceIndex++
        this.render()
        return Promise.resolve()
      case 'tap':
        // Enter confirms the TUI selection.
        this.sendChoiceKey('\r')
        this.answeredItem(this.choiceTarget?.itemId)
        st.mode = 'conversation'
        this.render()
        void this.loadConversation().then(() => this.render())
        return Promise.resolve()
      case 'doubleTap':
        // Cancel without answering — the item stays queued.
        st.mode = 'conversation'
        this.render()
        return Promise.resolve()
    }
  }

  /** Choice keys go to the item's sessionId+paneId. REST needs no subscription
   *  and routes to the exact blocked pane; WS input is the fallback (#504). */
  private sendChoiceKey(data: string): void {
    const t = this.choiceTarget
    if (!t) return
    if (t.paneId) {
      void sendPaneInput(t.sessionId, t.paneId, data).catch(() => {
        this.ws.sendInput(t.sessionId, data)
      })
    } else {
      this.ws.sendInput(t.sessionId, data)
    }
  }

  // ── voice ──

  private async onVoiceAction(action: RingAction): Promise<void> {
    switch (action) {
      case 'tap':
        if (this.state.voicePhase === 'recording') {
          await this.stopAndTranscribe()
          return
        }
        if (this.state.voicePhase === 'confirm' && this.state.voiceText) {
          await this.sendVoice()
        }
        return
      case 'doubleTap':
        await this.cancelVoice()
        return
      default:
        return
    }
  }

  private async startVoice(target: ReplyTarget): Promise<void> {
    this.voiceTarget = target
    this.audioChunks = []
    this.state.mode = 'voice'
    this.state.voicePhase = 'recording'
    this.state.voiceText = ''
    this.state.voiceSessionName = this.sessionLabel(target.sessionId)
    this.render()
    this.recording = true
    const ok = await this.platform.startMicCapture()
    if (!ok) {
      this.recording = false
      this.state.voicePhase = 'confirm'
      this.state.voiceText = ''
      this.render()
    }
  }

  private async stopAndTranscribe(): Promise<void> {
    if (!this.recording) return
    this.recording = false
    await this.platform.stopMicCapture()
    this.state.voicePhase = 'transcribing'
    this.render()
    try {
      this.state.voiceText = await this.platform.transcribeAudio(concatPcm(this.audioChunks))
    } catch {
      this.state.voiceText = ''
    }
    this.state.voicePhase = 'confirm'
    this.render()
  }

  /** Free-text voice reply → POST prompt with the item's sessionId + paneId. */
  private async sendVoice(): Promise<void> {
    const t = this.voiceTarget
    const text = this.state.voiceText?.trim()
    if (t && text) {
      try { await sendPrompt(t.sessionId, text, t.paneId) } catch { /* ignore */ }
      this.answeredItem(t.itemId)
    }
    this.state.mode = 'conversation'
    this.render()
    void this.loadConversation().then(() => this.render())
  }

  private async cancelVoice(): Promise<void> {
    if (this.recording) {
      this.recording = false
      await this.platform.stopMicCapture()
    }
    this.state.mode = 'conversation'
    this.render()
  }

  // ── Transitions shared by several modes ──

  private enterOverlay(itemId?: string): void {
    this.overlayReturnMode = this.state.mode === 'conversation' ? 'conversation' : 'session_list'
    this.state.mode = 'overlay'
    this.state.overlayItemId = itemId ?? this.queue.topWaiting()?.id ?? null
    this.render()
  }

  private exitOverlay(): void {
    this.state.mode = this.overlayReturnMode
    this.state.overlayItemId = null
    this.render()
  }

  /** Jump to a relay item's session: subscribe + open its conversation, and
   *  enter choice mode straight away when the item carries choices (#504). */
  private async jumpToItem(item: GlassesRelayItem): Promise<void> {
    const idx = this.state.sessions.findIndex((s) => s.id === item.sessionId)
    if (idx >= 0) this.state.sessionIndex = idx
    this.ws.subscribe(item.sessionId)
    this.state.mode = 'conversation'
    this.state.overlayItemId = null
    this.state.conversation = []
    this.state.conversationOffset = 0
    this.state.conversationPage = 0
    if (item.choices?.length) {
      this.enterChoice(item.choices, { sessionId: item.sessionId, paneId: item.paneId, itemId: item.id })
      void this.loadConversation().then(() => this.render())
      return
    }
    this.render()
    await this.loadConversation()
    this.render()
  }

  private enterChoice(options: string[], target: ReplyTarget): void {
    this.choiceTarget = target
    this.state.choiceOptions = options
    this.state.choiceIndex = 0
    this.state.choiceSessionName = this.sessionLabel(target.sessionId)
    this.state.mode = 'choice'
    this.render()
  }

  /** Dismiss an item ("later / on PC"). Optimistic local drop; the server's
   *  dismissed reflection is then a no-op. Restored when the REST call fails. */
  private async dismissItem(item: GlassesRelayItem): Promise<void> {
    this.queue.remove(item.id)
    this.syncRelay()
    if (this.state.mode === 'overlay') {
      const next = this.queue.topWaiting()
      if (next) {
        this.state.overlayItemId = next.id
        this.render()
      } else {
        this.exitOverlay()
      }
    } else {
      this.render()
    }
    try {
      await dismissRelayItem(item.id)
    } catch {
      this.queue.upsert(item)
      this.syncRelay()
      this.render()
    }
  }

  /** A relay item was answered (choice Enter / voice send). Auto items clear
   *  themselves when herdr reports the pane unblocked, so they are left alone
   *  here. Agent self-notes have no blocked epoch to clear them, so drop the
   *  item explicitly — optimistic local remove + server dismiss so a reconnect
   *  snapshot doesn't resurrect it — else it lingers on the glasses (#504). */
  private answeredItem(itemId: string | undefined): void {
    if (!itemId) return
    const item = this.queue.get(itemId)
    if (!item || item.source !== 'agent') return
    this.queue.remove(itemId)
    this.syncRelay()
    void dismissRelayItem(itemId).catch(() => { /* reconnect snapshot re-syncs */ })
  }

  /** Terminal scrape — fallback when the active waiting item has no choices. */
  private async scrapeChoices(sessionId: string): Promise<string[]> {
    await this.ws.requestContentAndWait(sessionId)
    return this.ws.getChoices(sessionId)
  }

  // ── WS event wiring ──

  private onWsReady(): void {
    // Re-subscribe the session being viewed after a reconnect (the relay
    // subscription itself is re-sent by the WS client).
    const s = this.currentSession()
    if (s && this.state.mode !== 'session_list') this.ws.subscribe(s.id)
  }

  private onSessionsUpdated(sessions: Session[], focus?: ClientFocus): void {
    const st = this.state
    const prevId = st.sessions[st.sessionIndex]?.id
    // Update session data in-place (preserve sort order during conversation/choice)
    if (st.mode !== 'session_list' && prevId) {
      const newMap = new Map(sessions.filter((s) => s.state !== 'lost').map((s) => [s.id, s]))
      st.sessions = st.sessions
        .map((s) => newMap.get(s.id) || s)
        .filter((s) => newMap.has(s.id))
      // Add any new sessions at the end
      for (const s of sessions) {
        if (s.state !== 'lost' && !st.sessions.some((e) => e.id === s.id)) {
          st.sessions.push(s)
        }
      }
    } else {
      st.sessions = this.sortSessions(sessions)
    }
    // Re-find the previously selected session
    if (prevId) {
      const newIdx = st.sessions.findIndex((s) => s.id === prevId)
      st.sessionIndex = newIdx >= 0 ? newIdx : Math.min(st.sessionIndex, Math.max(0, st.sessions.length - 1))
    } else if (st.sessionIndex >= st.sessions.length) {
      st.sessionIndex = Math.max(0, st.sessions.length - 1)
    }
    if (this.followFocus(focus)) return // already re-rendered
    this.render()
    this.maybeRefreshConversation()
  }

  /** Follow the session the user opened on the phone/tablet in their hand.
   *  Returns true when it took over the render.
   *
   *  Deliberately narrow: it never changes mode, so a glance at the session
   *  list is not yanked into a conversation. It also yields to every mode that
   *  is mid-decision or mid-send — a reply must land where the header says it
   *  will, and the phone moving on cannot be allowed to redirect it. */
  private followFocus(focus: ClientFocus | undefined): boolean {
    if (!focus) return false // every client hidden → hold the current view
    const st = this.state
    if (st.mode !== 'session_list' && st.mode !== 'conversation') return false
    if (focus.sessionId === st.sessions[st.sessionIndex]?.id) return false
    const idx = st.sessions.findIndex((s) => s.id === focus.sessionId)
    if (idx < 0) return false

    st.sessionIndex = idx
    if (st.mode === 'session_list') {
      // Move the cursor only; entering a session stays a deliberate tap.
      this.render()
      return true
    }
    this.ws.subscribe(focus.sessionId)
    st.conversation = []
    st.conversationOffset = 0
    st.conversationPage = 0
    this.render()
    void this.loadConversation().then(() => this.render())
    return true
  }

  private onRelaySnapshot(items: GlassesRelayItem[]): void {
    this.queue.applySnapshot(items)
    this.syncRelay()
    // (Re)connected: with waiting items pending and the user idling in the
    // session list, present the overlay immediately (proactive overlay #504).
    if (this.state.mode === 'session_list' && this.queue.topWaiting()) {
      this.enterOverlay()
      return
    }
    this.render()
  }

  private onRelayUpsert(item: GlassesRelayItem): void {
    const isNew = this.queue.upsert(item)
    this.syncRelay()
    // A brand-new waiting item interrupts the session list; in the other
    // modes the banner / header badge surfaces it without yanking the view.
    if (isNew && item.kind === 'waiting' && this.state.mode === 'session_list') {
      this.enterOverlay(item.id)
      return
    }
    this.render()
  }

  /** Item removed server-side (blocked resolved / TTL) → clear the overlay. */
  private onRelayRemove(id: string): void {
    if (!this.queue.remove(id)) return
    this.syncRelay()
    if (this.state.mode === 'overlay') {
      const cur = this.state.overlayItemId ? this.queue.get(this.state.overlayItemId) : undefined
      if (!cur) {
        const next = this.queue.topWaiting()
        if (next) {
          this.state.overlayItemId = next.id
        } else {
          // Queue drained — the overlay clears automatically.
          this.exitOverlay()
          return
        }
      }
    }
    this.render()
  }

  // ── Sessions / conversation data ──

  private currentSession(): Session | undefined {
    return this.state.sessions[this.state.sessionIndex]
  }

  private sessionLabel(sessionId: string): string {
    const s = this.state.sessions.find((x) => x.id === sessionId)
    return s ? s.customTitle || s.name || s.id.slice(0, 8) : sessionId
  }

  /** Waiting-first ordering: sessions with a relay waiting item lead, then the
   *  indicator order (waiting_input → processing → completed → idle). */
  private sortSessions(sessions: Session[]): Session[] {
    const order: Record<string, number> = { waiting_input: 0, processing: 1, completed: 2, idle: 3 }
    const relayIds = new Set(this.queue.waitingItems().map((i) => i.sessionId))
    return [...sessions]
      .filter((s) => s.state !== 'lost')
      .sort((a, b) => {
        const ra = relayIds.has(a.id) ? -1 : (order[a.indicatorState || 'idle'] ?? 9)
        const rb = relayIds.has(b.id) ? -1 : (order[b.indicatorState || 'idle'] ?? 9)
        return ra - rb
      })
  }

  private syncRelay(): void {
    this.state.relayWaiting = this.queue.waitingItems()
    this.state.relayInfo = this.queue.infoItems()
  }

  private currentMsgTotalPages(): number {
    return getTotalPagesAt(this.state.conversation, this.state.conversationOffset)
  }

  private async loadConversation(): Promise<void> {
    const session = this.currentSession()
    if (!session?.ccSessionId) {
      this.state.conversation = []
      this.state.conversationLastLoaded = 0
      this.state.conversationHasMore = false
      return
    }
    const raw = await getConversation(session.ccSessionId, INITIAL_LOAD_COUNT)
    this.state.conversation = filterConversation(raw)
    this.state.conversationLastLoaded = INITIAL_LOAD_COUNT
    // If backend returned exactly the requested count, more may be available.
    this.state.conversationHasMore = raw.length >= INITIAL_LOAD_COUNT
    this.state.conversationOffset = 0
    this.state.conversationPage = 0
  }

  /** Load more older messages by requesting a larger `last` count. Returns true if new messages were added. */
  private async loadMoreConversation(): Promise<boolean> {
    const session = this.currentSession()
    if (!session?.ccSessionId) return false
    if (!this.state.conversationHasMore || this.state.conversationLoading) return false

    this.state.conversationLoading = true
    try {
      const newLast = this.state.conversationLastLoaded + LOAD_MORE_INCREMENT
      const raw = await getConversation(session.ccSessionId, newLast)
      const filtered = filterConversation(raw)
      // If no new messages were added, we've reached the beginning.
      if (filtered.length <= this.state.conversation.length) {
        this.state.conversationHasMore = false
        this.state.conversationLastLoaded = newLast
        return false
      }
      this.state.conversation = filtered
      this.state.conversationLastLoaded = newLast
      this.state.conversationHasMore = raw.length >= newLast
      return true
    } finally {
      this.state.conversationLoading = false
    }
  }

  /** Auto-refresh the conversation when terminal output arrives (throttled). */
  private maybeRefreshConversation(): void {
    if (this.state.mode !== 'conversation') return
    // Never refresh out from under someone who has scrolled back:
    // loadConversation resets offset and page, so a reader was being yanked
    // to the newest message every few seconds. Paging back to the latest
    // resumes live updates.
    if (this.state.conversationOffset > 0 || this.state.conversationPage > 0) return
    const now = Date.now()
    if (now - this.lastConvRefresh < CONV_REFRESH_INTERVAL) return
    this.lastConvRefresh = now
    void this.loadConversation().then(() => this.render())
  }

  private render(): void {
    this.platform.render(this.state)
  }
}

function isSessionWaiting(s: Session): boolean {
  return s.indicatorState === 'waiting_input' || (!!s.waitingToolName && s.waitingToolName !== 'UserInput')
}
