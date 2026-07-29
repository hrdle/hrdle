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

import { getConversation, sendPrompt, sendPaneInput, dismissRelayItem, reportLog } from './api.ts'
import { SPINNER_INTERVAL_MS, getTotalPagesAt, getMultiCountAt, listRows, noticeScrollSteps, rowCursor } from './display.ts'
import type { AppState } from './display.ts'
import { RelayQueue } from './relay-queue.ts'
import { WsClient } from './ws-client.ts'
import type { Session, Pane, ConversationMessage, GlassesRelayItem, ClientFocus } from './types.ts'

const INITIAL_LOAD_COUNT = 20
const LOAD_MORE_INCREMENT = 20
const CONV_REFRESH_INTERVAL = 3000
/**
 * How long a notification holds the panel before giving it back.
 *
 * Long enough to be read at a glance without hurrying — a completion line plus
 * a sentence of recap — and short enough that a wearer walking around is not
 * looking through a message about something they already knew.
 */
export const NOTICE_DISMISS_MS = 8000
/**
 * How long the ring has to be still before the screen starts moving itself.
 *
 * The point is that a reader who is working the ring is
 * never fought for control. Long enough that a pause between gestures is not
 * mistaken for having finished reading.
 */
const AUTO_ADVANCE_IDLE_MS = 10_000
/**
 * Seconds a line of Japanese gets before the screen moves on.
 *
 * Measured against the device rather than guessed: five seconds for a whole
 * three-line strip read as hurried, and fifteen for the same strip read right
 * — which is this, per line.
 *
 * Every step is a redraw over BLE, so slow is also cheap.
 */
const SECONDS_PER_LINE_MS = 5000

/**
 * How often the notice gives up another `NOTICE_SCROLL_CHARS` from its front.
 *
 * The strip scrolls by character now, so a step is a fraction of a line rather
 * than a whole one and has to come round proportionally sooner. Ten characters
 * every two and a half seconds is four a second — the same reading pace the
 * five-second line was approved at, in thirds of a line instead of whole ones.
 *
 * Paced with `NOTICE_SCROLL_CHARS` rather than independently of it: the two
 * set the reading speed together, and only their ratio to each other sets how
 * often the glasses redraw. Halving both would read identically and cost twice
 * as much over BLE.
 *
 * It is also the clock every other interval below is counted in, so those stay
 * multiples of it.
 */
const AUTO_SCROLL_STEP_MS = 2500

/**
 * A page turn replaces the whole body, so it is priced as the strip was: three
 * lines' worth. Not seven — a page is skimmed for where it left off, not read
 * from the top.
 */
const AUTO_PAGE_STEP_MS = 3 * SECONDS_PER_LINE_MS

/**
 * How long the end of a scroll stays up before it goes back to the top.
 *
 * Without it the last line appeared and was gone in the time any other line
 * gets — and the last line is the one worth waiting for. Priced like a page
 * turn: long enough to finish the sentence and look away.
 */
const AUTO_SCROLL_DWELL_MS = 3 * SECONDS_PER_LINE_MS

/**
 * How many times round the recap goes before it rests.
 *
 * Looping was the point — a reader looking up a minute later should find it
 * readable from the start — but looping forever means a full redraw every five
 * seconds for as long as the conversation stays open, over BLE, for nobody.
 * Two passes is a minute of motion, which is long enough for someone who is
 * there and short enough not to spend the evening drawing for someone who is
 * not. A ring gesture starts the count over: that is a reader arriving.
 */
const AUTO_SCROLL_MAX_PASSES = 2

export type RingAction = 'tap' | 'doubleTap' | 'swipeUp' | 'swipeDown'

/** Platform capabilities the controller cannot provide itself. The G2 wires
 *  the real Even Hub bridge + mic; the debug simulator fakes them. */
export interface GlassesPlatform {
  /**
   * Real hardware, not the browser simulator.
   *
   * Both run this controller and both show the same screen; the difference is
   * that only a wearer has actually been told something. The server silences
   * the browser push on this, so a simulator claiming it would take the user's
   * notifications away while a preview window sat open on their desk.
   */
  onDevice: boolean
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
  /** Durable across a WebView restart. The device writes to the host app's
   *  storage, which outlives the page; the simulator uses localStorage. */
  saveState(json: string): void
  loadState(): Promise<string | null>
  /**
   * Ask the host to show its own exit confirmation.
   *
   * `shutDownPageContainer(1)`, not `(0)`: the user gets a dialogue they can
   * cancel, and confirming it is what produces `SYSTEM_EXIT_EVENT`. Nothing is
   * cleaned up here — the exit is not decided yet, and tearing down a listener
   * for a dialogue the user then cancels leaves the app on screen and deaf.
   */
  requestExit(): void
  /**
   * A gesture arrived while this app was believed to be in the background.
   *
   * The host routes ring input to whatever the glasses are showing, so the
   * gesture is proof the belief is wrong. The platform layer keeps its own
   * copy of that flag (the heartbeat reports it) and its own idea of what the
   * panel is showing, and both are stale by the time this is called.
   */
  onForegroundRegained(): void
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
  readonly ws: WsClient
  private readonly platform: GlassesPlatform
  private readonly queue = new RelayQueue()

  private choiceTarget: ReplyTarget | null = null
  private voiceTarget: ReplyTarget | null = null
  private overlayReturnMode: 'session_list' | 'conversation' = 'session_list'
  /** Pending auto-dismissal of a notification overlay; null when none is due. */
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  /** Last ring gesture, so the auto-advance clock can stay out of the way. */
  private lastGestureAt = 0
  /** What that gesture was. Reported on the way out: `SYSTEM_EXIT_EVENT` is
   *  the user confirming the host's exit dialogue, so what they pressed just
   *  before it is the difference between "they meant to leave" and "the app
   *  handed a gesture to the OS that the wearer meant for the app". */
  private lastGestureKind: RingAction | 'none' = 'none'
  /** Whether this app is the one the glasses are showing. Render calls made
   *  while it is not are consumed by the host and never reach the display, so
   *  they are pure BLE traffic for a panel nobody is looking at. */
  private foreground = true
  /** Ticks since the last auto step, so a page turn can cost several of them. */
  private autoTicks = 0
  /** Completed passes over the recap, counted towards AUTO_SCROLL_MAX_PASSES. */
  private autoPasses = 0
  /** Set once the screen has shown everything it has, twice. Nothing moves
   *  again until a gesture says someone is there. */
  private autoResting = false

  private audioChunks: Uint8Array[] = []
  private recording = false
  private lastConvRefresh = 0

  constructor(platform: GlassesPlatform) {
    this.platform = platform
    this.ws = new WsClient({
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
    this.ws.subscribeGlassesRelay(this.platform.onDevice)
    this.ws.connect()
    // One timer for the life of the app rather than start/stop bookkeeping on
    // every state change. It costs nothing when nothing is working: the tick
    // returns before touching the display.
    setInterval(() => this.tickSpinner(), SPINNER_INTERVAL_MS)
    setInterval(() => this.tickAutoAdvance(), AUTO_SCROLL_STEP_MS)
  }

  /**
   * Show the next thing that does not fit.
   *
   * Seven lines is not enough for a recap and a conversation at once, so both
   * used to end at `…` — the reader told there was more, with no way to reach
   * it. This walks the overflow instead: the notice strip first, then the
   * pages of the message, one step at a time, and stops when there is nothing
   * left to show rather than looping back.
   *
   * One thing moves at a time. A screen with a scrolling recap above a paging
   * conversation is not readable at a glance, which is the only way this
   * screen is ever read.
   */
  private tickAutoAdvance(): void {
    const st = this.state
    if (st.mode !== 'conversation') return
    // Nobody is looking at this panel, and nothing sent to it would arrive.
    // Advancing anyway would also walk the recap past the point the reader
    // left it, so they come back to the middle of something.
    if (!this.foreground) return
    // Everything has been shown, twice. Drawing again would be for nobody.
    if (this.autoResting) return
    // The reader is working the ring; do not fight them for it.
    if (Date.now() - this.lastGestureAt < AUTO_ADVANCE_IDLE_MS) return

    const steps = noticeScrollSteps(st)
    if ((st.noticeWindow ?? 0) < steps - 1) {
      st.noticeWindow = (st.noticeWindow ?? 0) + 1
      this.autoTicks = 0
      this.render()
      return
    }

    // The scroll is at its end, or there was nothing to scroll. Either way the
    // strip has said what it has, so the next step waits longer than a line:
    // a page turn's worth, which is also how long the last line deserves
    // before it is taken away.
    const wait = steps > 1 ? AUTO_SCROLL_DWELL_MS : AUTO_PAGE_STEP_MS
    if (++this.autoTicks < wait / AUTO_SCROLL_STEP_MS) return
    this.autoTicks = 0

    const totalPages = this.currentMsgTotalPages()
    if (st.conversationPage < totalPages - 1) {
      // Turning the page drops the recap anyway (deeper paging buys message
      // space with it), so there is nothing to send back to the top.
      st.conversationPage++
      this.render()
      return
    }
    // Nothing further to page to. Back to the first character of the recap and
    // round again, rather than sitting on its tail forever — the reader who
    // looks up a minute later should find it readable from the start.
    if (steps > 1 && (st.noticeWindow ?? 0) !== 0) {
      // Back to the top, then count the pass. Resting at the top rather than
      // on the tail: whenever the reader does look up, the recap reads from
      // its beginning.
      st.noticeWindow = 0
      this.render()
      if (++this.autoPasses >= AUTO_SCROLL_MAX_PASSES) this.autoResting = true
      return
    }
    // Nothing scrolls and no page is left — there is nothing to come back for.
    this.autoResting = true
    // Everything on this screen has been shown. Stop: arriving at the end and
    // staying there is what "read it all" looks like.
  }

  /** Advance the working indicator, but only where it is being looked at and
   *  only while there is something to indicate. */
  private tickSpinner(): void {
    const st = this.state
    // Nothing drawn from the background arrives, so an animation run there is
    // spent entirely on the way to being dropped.
    if (!this.foreground) return
    if (!this.somethingIsWorking()) return
    st.spinnerTick = (st.spinnerTick ?? 0) + 1
    this.platform.renderHeader(st)
  }

  /** Whether a spinner is on screen at all. Nothing working means nothing to
   *  redraw, and an idle app sends nothing. */
  private somethingIsWorking(): boolean {
    const st = this.state
    if (st.mode === 'conversation') {
      const pane = (this.currentSession()?.panes ?? []).find((p) => p.paneId === st.selectedPaneId)
      return (pane ?? this.currentSession())?.indicatorState === 'processing'
    }
    if (st.mode !== 'session_list') return false
    // The list shows every row's badge, so any working agent keeps it moving.
    return st.sessions.some(
      (s) =>
        s.indicatorState === 'processing' ||
        (s.panes ?? []).some((p) => p.indicatorState === 'processing'),
    )
  }

  // ── Suspend and resume ──
  //
  // The phone suspends the WebView whenever the Even app goes to the
  // background — lock screen, app switcher — and the app looks dead from the
  // wearer's side. It is not a crash and cannot be prevented from here, so
  // what is left is to come back well: notice the resume, reconnect, and pick
  // up where the reader was rather than at the top of a fresh list.

  /** Anything older than this is not where the reader still is. */
  private static readonly RESUME_WINDOW_MS = 30 * 60 * 1000

  private saveResumePoint(): void {
    const st = this.state
    const session = this.currentSession()
    try {
      this.platform.saveState(
        JSON.stringify({
          at: Date.now(),
          mode: st.mode === 'conversation' ? 'conversation' : 'session_list',
          sessionId: session?.id,
          paneId: st.selectedPaneId,
          offset: st.conversationOffset,
          page: st.conversationPage,
        }),
      )
    } catch { /* a resume point is a nicety; never let it take the app down */ }
  }

  /** Put the reader back where they were, if they were there recently. */
  private async restoreResumePoint(): Promise<void> {
    let saved: { at?: number; mode?: string; sessionId?: string; paneId?: string; offset?: number; page?: number }
    try {
      const raw = await this.platform.loadState()
      if (!raw) return
      saved = JSON.parse(raw)
    } catch {
      return
    }
    if (!saved.at || Date.now() - saved.at > GlassesController.RESUME_WINDOW_MS) return
    if (saved.mode !== 'conversation' || !saved.sessionId) return
    const idx = this.state.sessions.findIndex((s) => s.id === saved.sessionId)
    if (idx < 0) return
    const st = this.state
    this.restoringResumePoint = true
    try {
      st.sessionIndex = idx
      st.selectedPaneId = saved.paneId
      st.mode = 'conversation'
      this.ws.subscribe(saved.sessionId)
      this.render()
      await this.loadConversation()
      // Offset survives; the page does not, because the conversation may have
      // grown and page N of the old text is not page N of the new.
      st.conversationOffset = Math.min(saved.offset ?? 0, Math.max(0, st.conversation.length - 1))
      this.render()
    } finally {
      this.restoringResumePoint = false
    }
  }

  /** The app is back. Its socket died while it slept and its screen is stale. */
  onForegroundEnter(): void {
    this.foreground = true
    this.state.spinnerTick = 0
    this.ws.connect()
    this.render()
    void this.maybeRefreshConversation()
  }

  onForegroundExit(): void {
    // Stop drawing. The host consumes render calls made from the background
    // and drops them before the display, so everything sent from here is BLE
    // traffic that reaches nobody — and a WebView burning its budget on that
    // is a WebView the phone has a reason to throttle.
    this.foreground = false
    this.saveResumePoint()
  }

  /** What the wearer last did, and how long ago — for the exit line. */
  lastGesture(): { kind: RingAction | 'none'; agoMs: number } {
    return {
      kind: this.lastGestureKind,
      agoMs: this.lastGestureAt ? Date.now() - this.lastGestureAt : -1,
    }
  }

  onHostExit(_kind: 'abnormal' | 'system'): void {
    this.saveResumePoint()
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
    // Every ring gesture goes through here, so this is the one place that has
    // to know the reader is driving. The auto-advance clock stays out of the
    // way for AUTO_ADVANCE_IDLE_MS afterwards.
    this.lastGestureAt = Date.now()
    this.lastGestureKind = action
    // Only the app the glasses are showing is given ring input, so a gesture
    // outranks a stale `FOREGROUND_EXIT`. Without this the app draws nothing
    // for the rest of its life the first time an ENTER goes missing — which is
    // what cancelling the host's exit dialogue does — and a screen frozen on
    // its last frame is far worse than the traffic the flag was saving.
    if (!this.foreground) {
      this.foreground = true
      this.platform.onForegroundRegained()
    }
    // Someone is here. Whatever the screen had settled into, it starts over.
    this.autoPasses = 0
    this.autoResting = false
    switch (this.state.mode) {
      case 'session_list': return this.onSessionListAction(action)
      case 'conversation': return this.onConversationAction(action)
      case 'overlay': return this.onOverlayAction(action)
      case 'choice': return this.onChoiceAction(action)
      case 'voice': return this.onVoiceAction(action)
    }
  }

  // ── session_list ──

  /** Walk the list one row at a time. Rows are workspaces and, where a
   *  workspace holds more than one, its panes — so the same gesture moves
   *  between workspaces and into them without a second control. */
  private moveListCursor(step: number): void {
    const st = this.state
    const rows = listRows(st.sessions)
    if (!rows.length) return
    // Step over headings: a multi-pane workspace's name has nothing to open.
    let i = rowCursor(st)
    do {
      i += step
    } while (i >= 0 && i < rows.length && rows[i].header)
    if (i < 0 || i >= rows.length) return
    st.sessionIndex = rows[i].sessionIndex
    st.selectedPaneId = rows[i].paneId
  }

  private async onSessionListAction(action: RingAction): Promise<void> {
    const st = this.state
    switch (action) {
      case 'swipeUp':
        this.moveListCursor(-1)
        this.render()
        return
      case 'swipeDown':
        this.moveListCursor(1)
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
        st.noticeWindow = 0
        this.render()
        await this.loadConversation()
        this.render()
        return
      }
      case 'doubleTap':
        // The root page owes the host its exit dialogue. Even Hub review
        // rejects an app whose home screen does not call
        // `shutDownPageContainer(1)` on a double-tap ("Please ensure double
        // tapping at the root page on OS can invoke exit dialogue"), and the
        // OS treats root double-tap as the way out whether or not the app
        // agrees — which is how an app with its own meaning for the gesture
        // gets exited by someone who thought they were doing something else.
        //
        // The waiting overlay used to be here. It is not lost: an item that
        // needs an answer opens the overlay by itself, which is the path
        // every waiting item has actually arrived by.
        this.platform.requestExit()
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
          st.noticeWindow = 0
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
        // No relay items — legacy indicator flow (scrape, else voice). Reading
        // one pane, the reply belongs to that pane: sending it to the
        // workspace would land wherever herdr happens to have focus.
        //
        // Resolved against the open workspace rather than read raw: the cursor
        // keeps `selectedPaneId` from wherever it last stood, and several paths
        // move `sessionIndex` without it (a refresh reordering the list, a
        // relay item opening a conversation). A pane id from the previous
        // workspace is not a pane of this one, and the server — correctly —
        // refuses to guess, so the reply used to 404 into a swallowed catch.
        // Undefined here means "this workspace's active pane", which is the
        // right fallback and the one the server already implements.
        const paneId = this.currentPane()?.paneId
        if (cur && isSessionWaiting(cur)) {
          const scraped = await this.scrapeChoices(cur.id)
          if (scraped.length > 0) {
            this.enterChoice(scraped, { sessionId: cur.id, paneId })
            return
          }
        }
        if (cur) await this.startVoice({ sessionId: cur.id, paneId })
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
          st.noticeWindow = 0
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
    // The wearer is driving now; a notification must not vanish mid-gesture.
    this.clearNoticeTimer()
    const items = this.queue.sorted()
    const item = (st.overlayItemId ? this.queue.get(st.overlayItemId) : undefined) || items[0]
    switch (action) {
      case 'swipeUp':
      case 'swipeDown': {
        if (items.length < 2) return
        const idx = item ? items.indexOf(item) : 0
        const delta = action === 'swipeDown' ? 1 : -1
        st.overlayItemId = items[(idx + delta + items.length) % items.length].id
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

  /**
   * Free-text voice reply → POST prompt with the item's sessionId + paneId.
   *
   * A send that failed used to be indistinguishable from one that worked: the
   * error was swallowed, the item was marked answered anyway, and the screen
   * went back to the conversation. Spoken words disappeared with nothing to
   * say where — the only trace was a 404 in the server log, and only if someone
   * thought to look. So a failure now keeps the confirm screen up (the text is
   * still there, tap sends it again) and says so in the log.
   */
  private async sendVoice(): Promise<void> {
    const t = this.voiceTarget
    const text = this.state.voiceText?.trim()
    if (t && text) {
      try {
        await sendPrompt(t.sessionId, text, t.paneId)
      } catch (err) {
        void reportLog(
          'error',
          `voice send failed (session=${t.sessionId} pane=${t.paneId ?? 'active'}): ${err}`,
        )
        return
      }
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
    this.clearNoticeTimer()
    this.state.mode = this.overlayReturnMode
    this.state.overlayItemId = null
    this.render()
  }

  /**
   * Give the screen back on its own.
   *
   * A question is entitled to hold the panel until it is answered. A
   * notification is not: an agent finishing is a thing to have been told once,
   * and making the wearer raise a hand to clear every completion would turn
   * the feature into a chore. So it behaves like a notification anywhere else
   * — it appears, it is read, it leaves.
   */
  private scheduleNoticeDismiss(itemId: string): void {
    this.clearNoticeTimer()
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      // Only if it is still the thing on screen. A gesture or a newer item in
      // the meantime has already decided this item's fate.
      if (this.state.mode === 'overlay' && this.state.overlayItemId === itemId) {
        this.exitOverlay()
      }
    }, NOTICE_DISMISS_MS)
  }

  private clearNoticeTimer(): void {
    if (!this.noticeTimer) return
    clearTimeout(this.noticeTimer)
    this.noticeTimer = null
  }

  /**
   * Whether a notification may take the screen.
   *
   * Reading is interruptible — the overlay returns to the exact place it left,
   * and eight seconds later it does so by itself. Choosing an option and
   * dictating a prompt are not: the panel IS the input there, and replacing it
   * mid-gesture would lose what the wearer was in the middle of saying.
   */
  private canInterruptForNotice(item: GlassesRelayItem): boolean {
    if (this.state.mode === 'session_list') return true
    if (this.state.mode !== 'conversation') return false
    // Not about what is already on screen. "This conversation is done" thrown over
    // the conversation itself tells the reader nothing they cannot see, and an
    // agent working in bursts would raise it again every turn.
    return item.sessionId !== this.currentSession()?.id
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
    this.state.noticeWindow = 0
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

  /** Restore on the first list that arrives: before that there is no session
   *  to match the saved id against. */
  private maybeRestoreOnce(): void {
    if (this.restoredResumePoint || this.state.sessions.length === 0) return
    this.restoredResumePoint = true
    if (this.state.mode !== 'session_list') return // already somewhere on purpose
    void this.restoreResumePoint()
  }

  private onWsReady(): void {
    // Re-subscribe the session being viewed after a reconnect (the relay
    // subscription itself is re-sent by the WS client).
    const s = this.currentSession()
    if (s && this.state.mode !== 'session_list') this.ws.subscribe(s.id)
  }

  private restoredResumePoint = false
  /** True while the resume point is being put back. `loadConversation` ends by
   *  resetting the offset, so a periodic refresh landing mid-restore would
   *  undo it and drop the reader at the newest message — the very thing the
   *  resume point exists to avoid. */
  private restoringResumePoint = false

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
    this.maybeRestoreOnce()
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
    st.noticeWindow = 0
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
    // A notification is only a notification if it is seen, so it takes the
    // screen the same way — and then hands it back without being asked.
    if (isNew && item.kind === 'info' && this.canInterruptForNotice(item)) {
      this.enterOverlay(item.id)
      this.scheduleNoticeDismiss(item.id)
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

  /** The pane the cursor is on, when the list row was a pane. */
  private currentPane(): Pane | undefined {
    const id = this.state.selectedPaneId
    if (!id) return undefined
    return (this.currentSession()?.panes ?? []).find((p) => p.paneId === id)
  }

  /**
   * Which conversation the open view is reading, and by whose reader.
   *
   * A pane of a multi-pane workspace is its own agent conversation, with its
   * own session id — reading the workspace's showed one of them and silently
   * omitted the rest. The workspace level is the fallback, and there a thread
   * agent (kimi/codex/grok) carries `agentSessionId` where Claude carries
   * `ccSessionId`: taking only the latter left those workspaces reading an
   * empty Claude transcript, which is what `(no messages)` was (#5).
   */
  private conversationTarget(): { id: string; agent?: string } | undefined {
    const pane = this.currentPane()
    if (pane?.agentSessionId) return { id: pane.agentSessionId, agent: pane.agent }
    const session = this.currentSession()
    const id = session?.ccSessionId ?? session?.agentSessionId
    return id ? { id, agent: session?.agent } : undefined
  }

  /**
   * Reload the open conversation.
   *
   * Deliberately leaves `noticeWindow` alone: this runs on every refresh of a
   * conversation already being read, and resetting it here snapped the recap
   * back to its first line each time the agent said anything. Opening a
   * different conversation resets it — those call sites do it themselves.
   */
  private async loadConversation(): Promise<void> {
    const target = this.conversationTarget()
    if (!target) {
      this.state.conversation = []
      this.state.conversationLastLoaded = 0
      this.state.conversationHasMore = false
      return
    }
    const raw = await getConversation(target.id, INITIAL_LOAD_COUNT, target.agent)
    this.state.conversation = filterConversation(raw)
    this.state.conversationLastLoaded = INITIAL_LOAD_COUNT
    // If backend returned exactly the requested count, more may be available.
    this.state.conversationHasMore = raw.length >= INITIAL_LOAD_COUNT
    this.state.conversationOffset = 0
    this.state.conversationPage = 0
  }

  /** Load more older messages by requesting a larger `last` count. Returns true if new messages were added. */
  private async loadMoreConversation(): Promise<boolean> {
    // The same target the open view was loaded from: reading the workspace's
    // Claude transcript here swapped the conversation out from under a reader
    // who was paging back through a pane's.
    const target = this.conversationTarget()
    if (!target) return false
    if (!this.state.conversationHasMore || this.state.conversationLoading) return false

    this.state.conversationLoading = true
    try {
      const newLast = this.state.conversationLastLoaded + LOAD_MORE_INCREMENT
      const raw = await getConversation(target.id, newLast, target.agent)
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
    if (this.restoringResumePoint) return
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

  /**
   * Draw the current state — unless nobody would see it.
   *
   * The host drops render calls made from the background before they reach
   * the display, so every one of them is BLE traffic spent on nothing. State
   * still updates underneath; `onForegroundEnter` draws whatever it has become
   * in one frame, which is the only frame that was ever going to be seen.
   */
  private render(): void {
    if (!this.foreground) return
    this.platform.render(this.state)
  }
}

function isSessionWaiting(s: Session): boolean {
  return s.indicatorState === 'waiting_input' || (!!s.waitingToolName && s.waitingToolName !== 'UserInput')
}
