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
import { moveTo, type InlineChoices } from '../../shared/inline-choices'
import { ANSWER_ECHO_MS, CHECK_MARK, MAX_RECORDING_MS, SPINNER_INTERVAL_MS, choiceRows, isChecked, getTotalPagesAt, getMultiCountAt, hasNotificationRow, listRows, looksMultiSelect, noticeScrollSteps, onChoiceSend, rowCursor } from './display.ts'
import type { AppState } from './display.ts'
import {
  DEMO_REPLY_MS,
  DEMO_TRANSCRIBE_MS,
  demoAgentReply,
  demoAnswer,
  demoChoices,
  demoRecap,
  demoTranscript,
  demoConversation,
  demoSessions,
} from './demo.ts'
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
 * How long after answering a question the next one may take the screen.
 *
 * Sized against the round trip rather than against reading: the pane has to
 * redraw, the server's 5s tick has to notice, and the new item has to arrive.
 * Two ticks of headroom, and past that the wearer has moved on and it is a
 * notice like anything else.
 */
export const CHOICE_FOLLOW_MS = 15_000

/** The option label without its checkbox — what a row says, apart from whether
 *  it is ticked. */
export function choiceLabel(option: string): string {
  return option.replace(/^\s*\[[ xX*✓✔]\]\s*/, '').trim()
}

/** Whether two option sets are the same question with possibly different boxes
 *  ticked, as opposed to a different question altogether. */
export function sameLabels(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((o, i) => choiceLabel(o) === choiceLabel(b[i]))
}
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
 * How long the closing message stays on the panel before the run ends.
 *
 * Six lines at the reading pace the rest of this file assumes (five seconds a
 * line) would be half a minute, which is too long to hold a wearer who has
 * already noticed. This is the compromise: long enough to read the first line
 * and look up, short enough that the glasses are not held by a run that has
 * nothing left to do.
 */
const FATAL_LINGER_MS = 8000

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
  /** Transcribe collected PCM into text. `sessionId` is the workspace being
   *  spoken to, which biases the recognition toward that session's own
   *  vocabulary server-side (#166). */
  transcribeAudio(pcm: Uint8Array, sessionId?: string): Promise<string>
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
  /** Names this run of the app to the server, which is the only party able to
   *  see that the host left a previous one running. Absent in the simulator,
   *  which never takes part in retirement either way. */
  instanceId?: string
  /** This run has been retired in favour of a newer one. The controller has
   *  already let go of its own clocks, socket and microphone; this is for
   *  whatever the entry point started on its own. */
  onSuperseded?: () => void
  /** Close this run for good, without asking. Distinct from `requestExit`,
   *  which raises the host's cancellable dialogue: nothing here is a question
   *  to the wearer, and a cancelled exit would leave the run it was called for
   *  exactly as stuck as it already was. */
  exitNow?: () => void
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

/**
 * The rate the microphone is opened at, on the device and in the simulator
 * alike. Lived as a private constant in each of them until the silence
 * detector needed it too - and a detector counting samples at one rate while
 * the audio arrives at another is wrong by exactly that ratio, silently.
 */
export const MIC_SAMPLE_RATE = 16000

/**
 * How quiet counts as quiet, as RMS of 16-bit samples (full scale 32768).
 *
 * Deliberately low. Getting it wrong in one direction means a recording that
 * does not stop itself, and the 30-second limit catches that. Getting it wrong
 * in the other means cutting somebody off mid-sentence, which is the failure
 * nobody forgives. So the bar to clear is "louder than a quiet room", not
 * "clearly speech".
 */
const SPEECH_RMS = 600

/** Quiet for this long after speech, and the recording is over. */
const SILENCE_TAIL_SAMPLES = Math.round(MIC_SAMPLE_RATE * 1.5)

/**
 * Loudness of one chunk, as RMS.
 *
 * The bytes are little-endian signed 16-bit; read as unsigned they would make
 * every negative sample enormous and nothing would ever be quiet.
 */
export function pcmRms(pcm: Uint8Array): number {
  const n = pcm.length >> 1
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    let v = pcm[i * 2] | (pcm[i * 2 + 1] << 8)
    if (v >= 0x8000) v -= 0x10000
    sum += v * v
  }
  return Math.sqrt(sum / n)
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
  /**
   * Running on canned data, with no socket and no server.
   *
   * The screens, the gestures and the controller are the real ones - this only
   * decides where the data comes from and swallows the four things that would
   * otherwise reach an agent. A separate demo controller would be a second
   * implementation of every transition, and the ones that drift are always the
   * ones nobody is looking at.
   */
  private demo = false
  /** Turns the demo's own answers have added to the canned transcript, so a
   *  reply the wearer spoke or picked survives the next reload of it. */
  private demoExtra: ConversationMessage[] = []
  /** The agent's pending reply to one of them. Held so leaving the demo can
   *  stop it landing on a screen that is no longer the demo's. */
  private demoTimer: ReturnType<typeof setTimeout> | null = null
  private readonly platform: GlassesPlatform
  private readonly queue = new RelayQueue()

  private choiceTarget: ReplyTarget | null = null
  /**
   * Until when an answered pane may pull the wearer back into the picker.
   *
   * One AskUserQuestion holds several questions, and the pane draws the next
   * one straight after the Enter that answered the last. Without this the app
   * drops to the conversation and the remaining questions are only reachable
   * from the notice - which is the same screen the wearer just left, so in
   * practice they are not reachable at all.
   *
   * A window rather than a flag: it is a follow-up only while it plausibly
   * follows. Minutes later it is a new decision and gets a notice like any
   * other.
   */
  private choiceFollowUntil = 0
  private voiceTarget: ReplyTarget | null = null
  private overlayReturnMode: 'session_list' | 'conversation' = 'session_list'
  /** Pending auto-dismissal of a notification overlay; null when none is due. */
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  /** The two clocks started by `connect()`, held so the way out can stop them. */
  private spinnerTimer: ReturnType<typeof setInterval> | null = null
  private autoTimer: ReturnType<typeof setInterval> | null = null
  /** The gap between saying the run is closing and closing it. */
  private exitTimer: ReturnType<typeof setTimeout> | null = null
  /** Stops a recording nobody stopped (`MAX_RECORDING_MS`); null when idle. */
  private recordTimer: ReturnType<typeof setTimeout> | null = null
  /** Torn down by the host. Nothing draws, nothing reconnects, nothing ticks. */
  private stopped = false
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
  /** Whether anything above `SPEECH_RMS` has been heard in this recording. */
  private heardSpeech = false
  /** Samples of quiet since the last thing that was not quiet. */
  private silentSamples = 0
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
      onSuperseded: (by) => this.onSuperseded(by),
      onGiveUp: () => this.onWsGaveUp(),
    })
  }

  /**
   * A newer run of the app has connected; this one is the leftover.
   *
   * The host launches a new WebView without tearing down the previous one, and
   * from inside neither can see the other — everything-evenhub#16 records two
   * instances running concurrently for sixteen minutes, the stale one still
   * holding the microphone. The server can see both, so it is the one that says
   * which is which.
   *
   * No resume point is saved on the way out. The newcomer has already read the
   * saved one and is where the reader is; writing this instance's position over
   * it would move them back to wherever this run happened to be looking.
   */
  private onSuperseded(by: string): void {
    if (this.stopped) return
    this.log('error', `superseded: retired by instance ${by} — releasing everything`)
    this.shutdown()
    this.platform.onSuperseded?.()
  }

  /**
   * The server has been unreachable long enough to stop trying.
   *
   * Drawn before it goes, and the delay is the whole reason there is a gap
   * between saying so and doing it: a WebView that disappears looks exactly
   * like one the host killed, which is the failure the wearer has been living
   * with. A sentence on the panel is the difference between "it crashed again"
   * and "it could not reach the server, so it closed".
   *
   * `shutdown` runs after the message rather than before it, because it stops
   * the render queue.
   */
  private onWsGaveUp(): void {
    // Already counting down. The client only gives up once — it marks itself
    // closed before saying so — but a second call here would orphan the first
    // timer rather than replace it, and an interval nobody holds is exactly
    // what #46 was about.
    if (this.stopped || this.exitTimer) return
    this.log('error', 'ws: server unreachable — showing the reason, then closing')
    this.state.fatal = 'offline'
    this.render()
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null
      if (this.stopped) return
      this.shutdown()
      this.platform.exitNow?.()
    }, FATAL_LINGER_MS)
  }

  /**
   * Start on canned data instead of connecting.
   *
   * Nothing here opens a socket, so a demo run costs the network nothing and
   * survives having no server at all - which is the situation it exists for.
   */
  startDemo(): void {
    this.demo = true
    this.state.demo = true
    this.demoExtra = []
    this.clearDemoTimer()
    this.onSessionsUpdated(demoSessions())
    this.render()
  }

  /** Leave the demo, taking its data with it. The caller puts the setup guide
   *  back up; this only has to stop being a session list. */
  stopDemo(): void {
    this.demo = false
    this.state.demo = false
    this.clearDemoTimer()
    this.demoExtra = []
    this.state.sessions = []
    this.state.sessionIndex = 0
    this.state.conversation = []
    this.state.mode = 'session_list'
  }

  /**
   * An answer, taken as far as a real one goes.
   *
   * A demo that accepts a reply and shows nothing for it demonstrates the one
   * thing this app is for - answering an agent without a keyboard - stopping
   * one step short of the part that proves it worked. So the answer joins the
   * transcript as the wearer's turn, the workspace goes to work, and the agent
   * answers it.
   */
  private demoReply(text: string): void {
    this.demoExtra.push(demoAnswer(text))
    this.setDemoIndicator('processing')
    this.state.mode = 'conversation'
    void this.loadConversation().then(() => this.render())
    this.clearDemoTimer()
    this.demoTimer = setTimeout(() => {
      this.demoTimer = null
      if (!this.demo || this.stopped) return
      this.demoExtra.push(demoAgentReply(text))
      this.setDemoIndicator('completed')
      void this.loadConversation().then(() => this.render())
    }, DEMO_REPLY_MS)
  }

  /** The answered workspace's own indicator, so the list behind the transcript
   *  tells the same story: asked, working, done. */
  private setDemoIndicator(state: 'processing' | 'completed'): void {
    const target = this.state.sessions[this.state.sessionIndex]
    if (!target) return
    target.indicatorState = state
    // The recap leads the conversation screen and the demo's opening one says
    // the workspace is waiting. Answered, it is not.
    target.ccRecap = demoRecap(state)
  }

  private clearDemoTimer(): void {
    if (!this.demoTimer) return
    clearTimeout(this.demoTimer)
    this.demoTimer = null
  }

  /** Connect the WS and mark this connection as "glasses present" (#504). The
   *  relay subscription is (re)sent on every connect; the server answers with
   *  a snapshot, then pushes upserts/removals. */
  connect(): void {
    if (this.stopped) return
    this.ws.subscribeGlassesRelay(this.platform.onDevice, this.platform.instanceId)
    this.ws.connect()
    // One timer for the life of the app rather than start/stop bookkeeping on
    // every state change. It costs nothing when nothing is working: the tick
    // returns before touching the display.
    //
    // "The life of the app" was taken literally and the ids thrown away, which
    // left nothing able to stop them once the host took the app down — two
    // clocks drawing to a revoked panel for as long as the WebView lasted.
    this.spinnerTimer = setInterval(() => this.tickSpinner(), SPINNER_INTERVAL_MS)
    this.autoTimer = setInterval(() => this.tickAutoAdvance(), AUTO_SCROLL_STEP_MS)
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
    if (this.stopped || !this.foreground) return
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
    if (this.stopped || !this.foreground) return
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
    if (this.stopped) return
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
    // Close the microphone as well. Nothing would have closed it: a recording
    // interrupted by the glasses showing something else went on streaming 16kHz
    // PCM from a screen nobody could see, and the PCM stops arriving while
    // `recording` still claims otherwise — so the recording is abandoned rather
    // than left to resume into a screen that will never receive audio again.
    if (this.recording) void this.cancelVoice()
  }

  /** Whether the host has torn this down. Read by the simulator's diagnostics,
   *  where the whole point of the exit buttons is seeing that it took. */
  isStopped(): boolean {
    return this.stopped
  }

  /**
   * Log a line that says which run wrote it.
   *
   * `main.ts` stamps the run id on everything it traces, and lines written from
   * here were the exception — they reached the log naked, so a reader could not
   * tell which of two concurrent instances produced them, and the id-keyed log
   * monitor dropped them entirely.
   *
   * It mattered most for the one line that exists to identify an instance: the
   * retirement notice named the newcomer and not the run being retired. Fixed as
   * a class rather than a line, because the next `reportLog` added here would
   * have had the same hole.
   */
  private log(level: string, message: string): void {
    const id = this.platform.instanceId
    void reportLog(level, id ? `[${id}] ${message}` : message)
  }

  /** What the wearer last did, and how long ago — for the exit line. */
  lastGesture(): { kind: RingAction | 'none'; agoMs: number } {
    return {
      kind: this.lastGestureKind,
      agoMs: this.lastGestureAt ? Date.now() - this.lastGestureAt : -1,
    }
  }

  /**
   * The host has taken the app down. Put everything back before going quiet.
   *
   * Only reachable from `ABNORMAL_EXIT_EVENT` and `SYSTEM_EXIT_EVENT`, and
   * deliberately not from `requestExit`: asking the host for its exit dialogue
   * is not the same as leaving, and the wearer can cancel it.
   *
   * Until this existed the app kept running after the exit — drawing to a
   * container the host had revoked at about one refused write a second, one run
   * still going 64 minutes later. Official submission guidance rejects exactly
   * that ("Lingering webviews inside the Even Realities App are rejected"), and
   * a mic left open kept the BLE link busy for a screen nobody could see.
   */
  onHostExit(_kind: 'abnormal' | 'system'): void {
    // The host has been seen sending an exit while the app was already leaving,
    // and a second resume point written from a torn-down state is worse than
    // none — it would overwrite the one saved while the reader's place was still
    // known.
    if (this.stopped) return
    // First, because everything below stops things the save reads from.
    this.saveResumePoint()
    this.shutdown()
  }

  /**
   * Release everything this controller started.
   *
   * Idempotent, and safe to call from a handler that may fire more than once —
   * the host has been seen sending an exit while the app was already on the way
   * out. `stopped` is what makes it stick: clearing the timers stops the clocks,
   * but async work already in flight (a conversation load, a transcription)
   * still comes back and calls `render`, so the flag closes that door too.
   */
  private shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = null
    }
    if (this.autoTimer) {
      clearInterval(this.autoTimer)
      this.autoTimer = null
    }
    // The host can take the run down inside the closing message's own delay,
    // and then there is nothing left for that timer to close.
    if (this.exitTimer) {
      clearTimeout(this.exitTimer)
      this.exitTimer = null
    }
    // A recording the host tore down mid-way: the self-stop would otherwise
    // wake a dead controller up to transcribe and draw.
    this.clearRecordTimer()
    this.clearNoticeTimer()
    this.recording = false
    this.audioChunks = []
    this.heardSpeech = false
    this.silentSamples = 0
    // Unconditional: `recording` says whether the PCM was being collected, not
    // whether the microphone is open — `startVoice` opens it before anything
    // sets that flag, and a failed open leaves it false. `audioControl(false)`
    // on a closed mic costs one no-op call; a mic left open costs the wearer's
    // battery until the WebView dies.
    void Promise.resolve(this.platform.stopMicCapture()).catch(() => {})
    this.ws.close()
  }

  // ── Ring input (the single handler set shared by G2 and debug) ──

  tap(): void { void this.handle('tap') }
  doubleTap(): void { void this.handle('doubleTap') }
  swipeUp(): void { void this.handle('swipeUp') }
  swipeDown(): void { void this.handle('swipeDown') }

  /**
   * A chunk of microphone audio, and the decision of whether the sentence is
   * over.
   *
   * Counting quiet **samples** rather than elapsed milliseconds is what makes
   * this testable: the same chunks always produce the same decision, with no
   * clock to stub. It is also the more honest measure - what matters is how
   * much silence was recorded, not how long the host took to deliver it.
   *
   * Nothing happens until something has been said. Someone who taps and then
   * takes a moment to think would otherwise be cut off before their first
   * word, which is worse than the open microphone this exists to close.
   */
  onAudioData(pcm: Uint8Array): void {
    if (!this.recording) return
    this.audioChunks.push(pcm)

    if (pcmRms(pcm) >= SPEECH_RMS) {
      this.heardSpeech = true
      this.silentSamples = 0
      return
    }
    if (!this.heardSpeech) return
    this.silentSamples += pcm.length >> 1
    if (this.silentSamples >= SILENCE_TAIL_SAMPLES) void this.stopAndTranscribe()
  }

  /** Explicit state machine dispatch: (mode, action) → transition. */
  private async handle(action: RingAction): Promise<void> {
    // Gone. The host keeps delivering ring input to a page it has already
    // revoked, and acting on it would restart the very work `shutdown` stopped.
    if (this.stopped) return
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
    const rows = listRows(st.sessions, hasNotificationRow(st))
    if (!rows.length) return
    // Step over headings: a multi-pane workspace's name has nothing to open.
    let i = rowCursor(st)
    do {
      i += step
    } while (i >= 0 && i < rows.length && rows[i].header)
    if (i < 0 || i >= rows.length) return
    const row = rows[i]
    // The notices row is neither a session nor a pane, so where the cursor is
    // cannot be expressed by those two alone. Leaving the session fields as they
    // were is deliberate: swiping onto the notices and back off again returns to
    // the row the reader came from rather than to the top of the list.
    st.listOnNotifications = row.notifications === true
    if (row.notifications) return
    st.sessionIndex = row.sessionIndex
    st.selectedPaneId = row.paneId
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
        // The way in to the relay items. The overlay has always been able to
        // walk all of them — `swipe:next`, with a counter — and until now the
        // only thing that could open it was a question arriving.
        if (st.listOnNotifications && hasNotificationRow(st)) {
          this.enterOverlay()
          return
        }
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
        //
        // A demo root is still a root: the same gesture asks the same question
        // there. Routing it back to the setup screen instead would make the
        // one screen a reviewer reaches first the one place the gesture means
        // something else.
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
            this.enterChoice(
              top.choices,
              { sessionId: top.sessionId, paneId: top.paneId, itemId: top.id },
              this.inlineFromItem(top),
            )
            return
          }
          const scraped = await this.scrapeChoices(top.sessionId)
          if (scraped.length > 0) {
            this.enterChoice(
              scraped,
              { sessionId: top.sessionId, paneId: top.paneId, itemId: top.id },
              this.scrapedInline,
            )
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
            this.enterChoice(scraped, { sessionId: cur.id, paneId }, this.scrapedInline)
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
        // The one moment the order is allowed to change: whatever started
        // waiting while this conversation was open should be at the top when
        // the list comes back, and the cursor is not moving yet.
        this.resortSessions()
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
    const rows = choiceRows(st).length
    switch (action) {
      case 'swipeUp': {
        if (st.choiceIndex <= 0) return Promise.resolve()
        st.choiceIndex--
        this.render()
        return Promise.resolve()
      }
      case 'swipeDown': {
        if (st.choiceIndex >= rows - 1) return Promise.resolve()
        st.choiceIndex++
        this.render()
        return Promise.resolve()
      }
      case 'tap':
        // What a tap does depends on the row, and the row says which. An option
        // is answered by its own number; the send row is the Tab that carries a
        // multi-select on to the next question.
        if (st.choiceMulti && !onChoiceSend(st)) {
          // Tick it here as well as on the pane. The relay's re-read is what
          // makes it true, and that is a tick of the clock away - long enough
          // for a toggle to look like a gesture that did nothing.
          this.toggleLocalChoice()
          this.sendChoiceKey(String(st.choiceIndex + 1))
          return Promise.resolve()
        }
        if (this.inlineChoices) this.sendInlineChoice(st.choiceIndex)
        else this.sendChoiceKey(onChoiceSend(st) ? '\t' : String(st.choiceIndex + 1))
        this.answeredItem(this.choiceTarget?.itemId)
        this.choiceFollowUntil = Date.now() + CHOICE_FOLLOW_MS
        this.echoAnswer(this.pickedText())
        if (this.demo) {
          const picked = this.pickedText()
          if (picked) this.demoReply(picked)
          else st.mode = 'conversation'
          this.render()
          return Promise.resolve()
        }
        st.mode = 'conversation'
        this.render()
        void this.loadConversation().then(() => this.render())
        return Promise.resolve()
      case 'doubleTap':
        // Cancel without answering — the item stays queued. The same gesture
        // does the same thing on every screen, which is why the multi-select's
        // send is a row and not this.
        // Nothing was answered, so nothing follows: a picker that reopened
        // itself after being closed would be the app overruling the wearer.
        this.choiceTarget = null
        this.choiceFollowUntil = 0
        st.mode = 'conversation'
        this.render()
        return Promise.resolve()
    }
  }

  /**
   * Tick or untick the option under the cursor, in this app's own copy.
   *
   * The pane is the authority and its redraw arrives through the relay, so this
   * is a guess - but a guess that is right every time except when the key never
   * landed, and the next re-read corrects it. Without it the panel showed the
   * old box for as long as it took the server to look again, which reads as a
   * tap that did nothing on the one screen whose whole subject is the tap.
   */
  private toggleLocalChoice(): void {
    const st = this.state
    const opt = st.choiceOptions[st.choiceIndex]
    if (opt === undefined) return
    st.choiceOptions = st.choiceOptions.map((o, i) =>
      i === st.choiceIndex
        ? isChecked(o)
          ? o.replace(/\[[xX*\u2713\u2714]\]/, '[ ]')
          : o.replace('[ ]', `[${CHECK_MARK}]`)
        : o,
    )
    this.render()
  }

  /** What the wearer answered, as a sentence: the ticked options in a
   *  multi-select, the option under the cursor in a single-pick list. Null when
   *  a multi-select was sent with nothing ticked - there is no answer to relay
   *  and the demo should not invent one. */
  private pickedText(): string | null {
    const st = this.state
    if (!st.choiceMulti) {
      const one = st.choiceOptions[st.choiceIndex]
      return one ? choiceLabel(one) : null
    }
    const picked = st.choiceOptions.filter(isChecked).map(choiceLabel)
    return picked.length ? picked.join(', ') : null
  }

  /**
   * Say what was just sent, for a couple of seconds.
   *
   * The item itself stays until the server sees the pane move - a scraped
   * question belongs to the pane's blocked epoch and the app does not own its
   * lifetime. That leaves the tap silent, which on the device read as not
   * knowing whether the pick had gone anywhere. This says only what the app
   * actually knows: these are the keys that went.
   */
  private echoAnswer(text: string | null): void {
    if (!text) return
    this.state.answered = { text, until: Date.now() + ANSWER_ECHO_MS }
    if (this.echoTimer) clearTimeout(this.echoTimer)
    this.echoTimer = setTimeout(() => {
      this.echoTimer = null
      // Left in place rather than cleared on a timer alone: `relayBannerLines`
      // checks the clock too, so a render that happens for any other reason
      // already shows the right thing. This one exists to make a render happen
      // when nothing else would.
      this.render()
    }, ANSWER_ECHO_MS)
  }

  private echoTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Choice keys go to the item's sessionId+paneId. REST needs no subscription
   * and routes to the exact blocked pane; WS input is the fallback (#504).
   *
   * Only ever a key that names what it wants - a digit, a Tab, an Enter - and
   * never an arrow. Arrows made this screen a second cursor over the pane's
   * own, and the two came apart the moment anything redrew: every tick of a
   * multi-select box changes the option text, the relay re-reads it, the picker
   * reopens on the new item at row 1 while the pane's cursor is still on row 3,
   * and from then on each swipe moves the pane from somewhere the wearer cannot
   * see. Measured on a live pane on 2026-08-06 - three swipes in, the panel
   * offered `Banana` and the pane was sitting on `Type something`.
   *
   * `1`..`9` sidesteps all of it. Claude Code and kimi both take an option's own
   * number - choosing it in a single-pick list, ticking it in a multi-select -
   * and neither moves its cursor when they do, so there is no second cursor to
   * keep in step. The index this app holds is now a display cursor and nothing
   * more, which is what it always looked like from the outside.
   */
  private sendChoiceKey(data: string): void {
    const t = this.choiceTarget
    if (!t) return
    // Cursor movement is local to the panel in a demo; there is no pane whose
    // cursor could disagree with it, and nothing to send a key to.
    if (this.demo) return
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
    this.heardSpeech = false
    this.silentSamples = 0
    this.state.mode = 'voice'
    this.state.voicePhase = 'recording'
    this.state.voiceText = ''
    this.state.voiceFailed = false
    this.state.voiceSessionName = this.sessionLabel(target.sessionId)
    this.render()
    this.recording = true
    // Nothing to open a microphone for: transcription is the server's job and
    // a demo has no server, so a real recording would arrive at "(nothing was
    // recognized)" every time. The screens and the gestures are unchanged;
    // only the audio is not real.
    if (this.demo) return
    const ok = await this.platform.startMicCapture()
    if (!ok) {
      this.recording = false
      this.state.voicePhase = 'confirm'
      this.state.voiceText = ''
      this.render()
      return
    }
    // Only once the microphone is actually open: a start that failed has
    // nothing to stop, and arming the timer anyway would fire a transcription
    // of no audio half a minute after the wearer had moved on.
    this.recordTimer = setTimeout(() => void this.stopAndTranscribe(), MAX_RECORDING_MS)
  }

  /** Disarm the self-stop. Safe to call when it was never armed. */
  private clearRecordTimer(): void {
    if (this.recordTimer) {
      clearTimeout(this.recordTimer)
      this.recordTimer = null
    }
  }

  private async stopAndTranscribe(): Promise<void> {
    if (!this.recording) return
    this.recording = false
    // Whichever of the two stopped it, the other must not fire later.
    this.clearRecordTimer()
    if (this.demo) {
      this.state.voicePhase = 'transcribing'
      this.render()
      await new Promise((resolve) => setTimeout(resolve, DEMO_TRANSCRIBE_MS))
      this.state.voiceText = demoTranscript()
      this.state.voicePhase = 'confirm'
      this.render()
      return
    }
    await this.platform.stopMicCapture()
    this.state.voicePhase = 'transcribing'
    this.state.voiceFailed = false
    this.render()
    try {
      this.state.voiceText = await this.platform.transcribeAudio(
        concatPcm(this.audioChunks),
        this.voiceTarget?.sessionId,
      )
    } catch (err) {
      // Kept apart from an empty transcript (#209): the request not arriving
      // and the audio holding no words are different things to be told, and
      // only one of them is answered by speaking more clearly.
      console.warn('[voice] transcription failed:', err)
      this.state.voiceText = ''
      this.state.voiceFailed = true
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
        // Nothing is sent - there is no agent - but the conversation moves on
        // as it would have, which is the point of demonstrating this at all.
        if (this.demo) {
          this.demoReply(text)
          return
        }
        await sendPrompt(t.sessionId, text, t.paneId)
      } catch (err) {
        this.log(
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
    this.clearRecordTimer()
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
      this.enterChoice(
        item.choices,
        { sessionId: item.sessionId, paneId: item.paneId, itemId: item.id },
        this.inlineFromItem(item),
      )
      void this.loadConversation().then(() => this.render())
      return
    }
    this.render()
    await this.loadConversation()
    this.render()
  }

  /**
   * Whether an arriving waiting item is the continuation of the picker the
   * wearer is in, or has just left.
   *
   * Two cases, one rule - it has to be the same pane as the reply target:
   *
   * - still in the picker: the pane redrew with a different question under it,
   *   so every gesture from here was going to answer the wrong one
   * - just answered: the next question of a multi-step AskUserQuestion
   *
   * Not the item already being answered (a restatement of the same question is
   * not a new one), and never in the demo, where there is no pane to follow.
   */
  private shouldFollowChoice(item: GlassesRelayItem): boolean {
    if (this.demo) return false
    if (item.kind !== 'waiting' || !item.choices?.length) return false
    const t = this.choiceTarget
    if (!t || item.sessionId !== t.sessionId || item.id === t.itemId) return false
    // An unknown pane on either side is the single-pane case, where the
    // session already identifies the target.
    if (t.paneId && item.paneId && item.paneId !== t.paneId) return false
    if (this.state.mode === 'choice') return true
    return this.state.mode === 'conversation' && Date.now() < this.choiceFollowUntil
  }

  /**
   * Open the picker on a set of options.
   *
   * The cursor goes back to the top, except when the same question has simply
   * been re-read: a multi-select re-reads on every tick of a box, and a cursor
   * that jumped home each time made the second tick land somewhere the wearer
   * had not chosen. Same labels means same question - the boxes are what
   * changed, and where the wearer had got to is still where they are.
   */
  private enterChoice(options: string[], target: ReplyTarget, inline?: InlineChoices): void {
    const keepCursor =
      this.state.mode === 'choice' &&
      this.choiceTarget?.sessionId === target.sessionId &&
      this.choiceTarget?.paneId === target.paneId &&
      sameLabels(this.state.choiceOptions, options)
    this.choiceTarget = target
    this.choiceFollowUntil = 0
    this.state.choiceOptions = options
    this.state.choiceMulti = looksMultiSelect(options)
    // Set here rather than left over from whatever ran last: two halves feed
    // this - a relay item that already carries the reading, and a terminal
    // scrape that does it locally - and a stale value from one would answer
    // the other's question.
    this.inlineChoices = inline
    this.state.choiceInline = inline
    if (!keepCursor) this.state.choiceIndex = 0
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
      if (!this.demo) await dismissRelayItem(item.id)
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
    if (!this.demo) void dismissRelayItem(itemId).catch(() => { /* reconnect snapshot re-syncs */ })
  }

  /**
   * The pane's own reading of a side-by-side row, as the relay item carries it.
   *
   * The server does this scrape too, and once an item carries choices the app
   * never reaches its own scrape for that pane - so this is the path that
   * actually runs for a notification, and the local one is for a session whose
   * buffer the app happens to be subscribed to.
   *
   * Undefined unless the item says both which way it is answered and where the
   * pane's cursor is. A missing `choiceSelected` is not a zero: it would put
   * the walk at a guessed starting point, which is exactly the blind cursor
   * that had cursor-driving removed. An older server sends neither field, and
   * then this is undefined and the numbered path answers as it always did.
   */
  private inlineFromItem(item: { choices?: string[]; choiceInput?: string; choiceSelected?: number }): InlineChoices | undefined {
    if (item.choiceInput !== 'arrow') return undefined
    if (!item.choices?.length || typeof item.choiceSelected !== 'number') return undefined
    if (item.choiceSelected < 0 || item.choiceSelected >= item.choices.length) return undefined
    return { options: item.choices, selected: item.choiceSelected }
  }

  /** Terminal scrape — fallback when the active waiting item has no choices. */
  private async scrapeChoices(sessionId: string): Promise<string[]> {
    // The demo's waiting session is holding a multi-select: the picker with
    // the most to show, and the one that was broken until today.
    if (this.demo) return demoChoices()
    await this.ws.requestContentAndWait(sessionId)
    this.scrapedInline = undefined
    const numbered = this.ws.getChoices(sessionId)
    if (numbered.length > 0) return numbered
    // Only when the numbered and checkbox reads found nothing: a prompt that
    // has both would otherwise be answered the harder way.
    const inline = this.ws.getInlineChoices(sessionId)
    if (!inline) return []
    this.scrapedInline = inline
    return inline.options
  }

  /** What the last local scrape found, waiting to be handed to enterChoice. */
  private scrapedInline?: InlineChoices

  /**
   * Where the pane's own cursor sits on the row now open in the picker.
   * Undefined for every other kind of prompt, which is what keeps the
   * answering path below from firing on one.
   */
  private inlineChoices?: InlineChoices

  /**
   * Answer a row of side-by-side options: walk the pane's cursor to the row the
   * wearer picked, then confirm.
   *
   * The walk starts from a measured position rather than an assumed one, so a
   * redraw between the read and the tap cannot leave the two cursors pointing
   * at different things - the failure that had cursor-driving removed in
   * 0.0.52. Measured against a live OpenCode pane: the arrows move it, both
   * wrap, and Enter confirms.
   */
  private sendInlineChoice(index: number): void {
    const inline = this.inlineChoices
    if (!inline) return
    const move = moveTo(inline, index)
    const arrow = move.key === 'right' ? '\x1b[C' : '\x1b[D'
    // One payload, not one request per key.
    //
    // Each send is a POST of its own and none of them waits, so the order they
    // reach the PTY in is the order they happen to finish in. Measured by the
    // work-1 session on a cold control session: the first input pays for
    // ensurePaneReachable and listPanes, about 100ms, while the one behind it
    // takes 1ms - so Enter overtook the arrow and confirmed whatever the cursor
    // was still on. A wearer who picked Reject was told the command ran.
    //
    // Awaiting each one would also fix the order, but a walk is a single act
    // and there is no reason to let it be interleaved at all. In one request
    // the guarantee is real rather than probable: it is the single stdin pipe
    // the pane already promises.
    this.sendChoiceKey(arrow.repeat(move.count) + '\r')
    // The pane is where we just sent it; a re-read will confirm, but until then
    // this keeps a second tap from walking from a stale position.
    this.inlineChoices = { ...inline, selected: index }
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
    // Update the session data in place and hold the order the list is already
    // in. A refresh never re-sorts.
    //
    // Re-sorting here is what moved the cursor on its own. The order is by
    // indicator state, so one other session finishing was enough to shuffle
    // the row being aimed at somewhere else - measured on a live tailnet, a
    // single agent answering a question moved its own row from 11 to 2 and
    // shifted the nine between them, twice, inside ten seconds. A thumb
    // walking down the list cannot aim at a row that moves.
    //
    // Waiting-first is worth having when the list *opens*, which is what
    // `resortSessions` is for. It is not worth having while the list is being
    // read, and the two were the same code path until now.
    if (st.sessions.length) {
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
    // The reader is working the ring; do not fight them for it. The same rule
    // the auto-advance clock keeps, and for the same reason - a wearer swiping
    // down the list had the cursor pulled back to whatever a browser tab
    // elsewhere happened to be showing, every five seconds, for as long as
    // both were open. Following a phone is worth having when nobody is
    // holding the ring, and only then.
    if (Date.now() - this.lastGestureAt < AUTO_ADVANCE_IDLE_MS) return false
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
    // The next question of the one being answered. It takes the screen without
    // being asked, because the wearer is mid-answer and the alternative is a
    // notice they have to find their way back to.
    if (this.shouldFollowChoice(item)) {
      this.enterChoice(
        item.choices as string[],
        { sessionId: item.sessionId, paneId: item.paneId, itemId: item.id },
        this.inlineFromItem(item),
      )
      return
    }
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

  /**
   * Put the list back into waiting-first order, keeping the cursor on its
   * session wherever that lands.
   *
   * Called when the session list is opened, and never while it is on screen -
   * a list that rearranges under a moving thumb cannot be navigated. Between
   * openings the order is held and only the session data behind it refreshes.
   */
  private resortSessions(): void {
    const st = this.state
    const currentId = st.sessions[st.sessionIndex]?.id
    st.sessions = this.sortSessions(st.sessions)
    if (!currentId) return
    const idx = st.sessions.findIndex((s) => s.id === currentId)
    if (idx >= 0) st.sessionIndex = idx
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
    const raw = this.demo
      ? [...demoConversation(), ...this.demoExtra]
      : await getConversation(target.id, INITIAL_LOAD_COUNT, target.agent)
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
      // The demo's transcript is all of it; there is no older page.
      if (this.demo) {
        this.state.conversationLoading = false
        this.state.conversationHasMore = false
        return false
      }
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
    // `stopped` first: after a host exit the panel is not ours, and this is the
    // one place every draw passes through — including the ones asked for by
    // work that was already in flight when the exit arrived.
    if (this.stopped || !this.foreground) return
    this.platform.render(this.state)
  }
}

function isSessionWaiting(s: Session): boolean {
  return s.indicatorState === 'waiting_input' || (!!s.waitingToolName && s.waitingToolName !== 'UserInput')
}
