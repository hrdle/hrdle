// The app: what each gesture means on each screen, and what arriving data does
// to what is on the panel.
//
// One controller for the device and the simulator both. The platform below is
// the whole of what differs between them; everything a wearer would notice -
// which screen, which row, where a spoken sentence goes - is decided here, so
// the browser is exercising the app rather than an imitation of it.
//
// **The steward writes the words.** This file lays them out and routes what the
// wearer does about them; it never composes a sentence for the panel, never
// decides whether something deserves the screen, and never infers a choice from
// what a pane looks like. That whole class of work - the reason the other app's
// controller is 2900 lines - is on the server now.

import {
  getConversation,
  getSessionTurns,
  getSessions,
  getSteward,
  replyToSteward,
  reportSpokenDirectly,
  sendPrompt,
  summariseSession,
} from './api.ts'
import {
  askRows,
  directPages,
  draftText,
  initialState,
  micLevel,
  overviewRows,
  screenText,
  sessionPageCount,
  SPEECH_RMS,
} from './display.ts'
import type { AppState, DraftPhraseView, VoiceTarget } from './display.ts'
import { latestReport, pendingAsks, sessionName, sessionOfRow, threadAgentOf } from './types.ts'
import type { Session, StewardSessionLine, StewardThreadItem, StewardTurn } from './types.ts'
import { WsClient } from './ws-client.ts'

export type RingAction = 'tap' | 'doubleTap' | 'swipeUp' | 'swipeDown'

/** Platform capabilities the controller cannot provide itself. The G2 wires the
 *  real Even Hub bridge and microphone; the simulator fakes them. */
export interface GlassesPlatform {
  /**
   * Real hardware, not the browser simulator.
   *
   * Only a wearer has actually been shown something, so only a wearer's screen
   * is worth publishing to the server - `hrdle steward screen` is the steward
   * asking what its owner can see, and a preview window answering it would have
   * the steward reasoning about a screen nobody is looking at.
   */
  onDevice: boolean
  render(state: AppState): void
  /** Redraw the bar alone. The clock changes nothing else. */
  renderHeader(state: AppState): void
  startMicCapture(): Promise<boolean>
  stopMicCapture(): Promise<void>
  transcribeAudio(pcm: Uint8Array, sessionId?: string): Promise<string>
  /** The host's own exit confirmation, which the wearer can cancel. */
  requestExit(): void
  /** Close this run for good, without asking. */
  exitNow?: () => void
}

export const MIC_SAMPLE_RATE = 16000

/** Quiet for this long after speech, and the phrase is over. */
const SILENCE_TAIL_SAMPLES = Math.round(MIC_SAMPLE_RATE * 1.5)

/**
 * The shortest phrase worth a request of its own.
 *
 * Groq bills a minimum of ten seconds per transcription whatever the audio
 * measures, so a phrase closed at three seconds costs what a ten-second one
 * does. Under this a pause is part of the phrase rather than the end of it. A
 * tap is not subject to it: the wearer has said they are finished.
 */
const MIN_PHRASE_SAMPLES = MIC_SAMPLE_RATE * 10

/** Recording stops on its own here, so a forgotten microphone is not open for
 *  the rest of the day. */
const MAX_RECORDING_MS = 30_000

/** How often the bar redraws while recording. */
const LEVEL_REDRAW_MS = 250

/** The clock in the bar only moves once a minute; this is close enough. */
const HEADER_TICK_MS = 20_000

/** One phrase of the draft. `text` is null until the transcription answers. */
interface DraftPhrase {
  text: string | null
  failed: boolean
}

/** Loudness of one chunk of 16-bit PCM, as RMS. */
export function pcmRms(pcm: Uint8Array): number {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

/**
 * Join what was said into one instruction.
 *
 * Japanese runs together and English does not, so the join is decided by what
 * is on either side of it rather than by a setting.
 */
export function joinPhrases(phrases: string[]): string {
  const kept = phrases.map((p) => p.trim()).filter(Boolean)
  return kept.reduce((out, next) => {
    if (!out) return next
    return needsSpace(out.slice(-1), next.slice(0, 1)) ? `${out} ${next}` : out + next
  }, '')
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/

function needsSpace(before: string, after: string): boolean {
  return !CJK.test(before) && !CJK.test(after)
}

function concatPcm(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export class GlassesController {
  state: AppState = initialState()
  readonly ws: WsClient
  private platform: GlassesPlatform
  private headerTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  // Voice capture
  private audioChunks: Uint8Array[] = []
  private silenceSamples = 0
  private phraseSamples = 0
  private heardSpeech = false
  private recordingTimer: ReturnType<typeof setTimeout> | null = null
  private levelDrawnAt = 0
  private phrases: DraftPhrase[] = []

  constructor(platform: GlassesPlatform) {
    this.platform = platform
    this.ws = new WsClient({
      onSessionsUpdated: (sessions) => this.onSessions(sessions),
      onStewardSnapshot: (thread, lines) => this.onSnapshot(thread, lines),
      onStewardThread: (item) => this.onThreadItem(item),
      onStewardLine: (line) => this.onLine(line),
      onStewardTurns: (sessionId, turns) => this.onTurns(sessionId, turns),
      onStewardSessionRemoved: (sessionId) => this.onSessionRemoved(sessionId),
      onTerminalOutput: (sessionId, _paneId, text) => this.onTerminal(sessionId, text),
      onReady: () => this.onReady(),
      onGiveUp: () => this.onGiveUp(),
    })
  }

  connect(): void {
    this.ws.connect()
    this.headerTimer = setInterval(() => {
      if (!this.stopped) this.platform.renderHeader(this.state)
    }, HEADER_TICK_MS)
    // REST seeds the first paint. The socket's snapshot carries the thread and
    // the lines too, but a blocked socket would otherwise leave the panel on
    // "Connecting..." with no way to tell that from an empty server.
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    try {
      const [sessions, steward] = await Promise.all([getSessions(), getSteward()])
      this.state.sessions = sessions.sessions ?? []
      this.state.thread = steward.thread ?? []
      this.state.lines = steward.lines ?? []
      this.state.connected = true
      this.presentPendingAsk()
      this.render()
    } catch {
      // The socket is the live path; a failed seed only costs the first paint.
    }
  }

  private onReady(): void {
    this.ws.subscribeSteward()
  }

  private onGiveUp(): void {
    this.state.fatal = 'offline'
    this.render()
    // The screen is drawn first and the run closes after it: a WebView that
    // simply vanishes is indistinguishable from one that crashed, which is the
    // thing this says out loud.
    setTimeout(() => this.platform.exitNow?.(), 8000)
  }

  // ── incoming data ──

  private onSessions(sessions: Session[]): void {
    this.state.sessions = sessions
    this.state.connected = true
    this.clampCursor()
    this.render()
  }

  private onSnapshot(thread: StewardThreadItem[], lines: StewardSessionLine[]): void {
    this.state.thread = thread
    this.state.lines = lines
    this.state.connected = true
    this.presentPendingAsk()
    this.render()
  }

  private onThreadItem(item: StewardThreadItem): void {
    const at = this.state.thread.findIndex((i) => i.id === item.id)
    // An entry can be re-sent: answering a question rewrites the item it lives
    // on, and a second copy would leave the answered one on screen forever.
    if (at === -1) this.state.thread = [...this.state.thread, item]
    else this.state.thread = this.state.thread.map((i, n) => (n === at ? item : i))

    // The question on screen was just answered somewhere else - a phone, or the
    // steward withdrawing it. Leave it up and it is a question with no answer
    // that will ever arrive.
    if (this.state.ask && item.id === this.state.ask.id && item.kind === 'ask' && item.ask.answer) {
      this.state.ask = null
      if (this.state.screen === 'ask') this.leaveAsk()
    }

    this.presentPendingAsk()
    this.render()
  }

  private onLine(line: StewardSessionLine): void {
    const at = this.state.lines.findIndex((l) => l.sessionId === line.sessionId)
    if (at === -1) this.state.lines = [...this.state.lines, line]
    else this.state.lines = this.state.lines.map((l, n) => (n === at ? line : l))
    this.render()
  }

  private onTurns(sessionId: string, turns: StewardTurn[]): void {
    this.state.turns.set(sessionId, turns)
    if (sessionId === this.state.openSessionId) {
      this.state.sessionWaiting = false
      // Stay where the reader is, unless they were on a page that no longer
      // exists. Jumping to the newest turn under someone mid-read is the same
      // fault as a list that reorders while being scrolled.
      const pages = sessionPageCount(this.state)
      if (this.state.sessionPage >= pages) this.state.sessionPage = Math.max(0, pages - 1)
    }
    this.render()
  }

  private onSessionRemoved(sessionId: string): void {
    this.state.turns.delete(sessionId)
    this.state.lines = this.state.lines.filter((l) => l.sessionId !== sessionId)
    if (this.state.openSessionId === sessionId) this.toOverview()
    this.render()
  }

  private onTerminal(sessionId: string, text: string): void {
    if (sessionId !== this.state.openSessionId) return
    this.state.directText = text
    if (this.state.screen === 'direct') this.render()
  }

  // ── questions ──

  /**
   * Put an unanswered question on screen, unless now is the wrong moment.
   *
   * The two states it must not take are the two where the wearer is in the
   * middle of something addressed elsewhere: speaking (the sentence would go to
   * a screen they did not choose) and direct mode (they stepped down into one
   * pane deliberately). Both leave a strip instead, and the question is
   * presented the moment they come back up.
   */
  private presentPendingAsk(): void {
    const waiting = pendingAsks(this.state.thread)
    const next = waiting[waiting.length - 1]
    if (!next) {
      this.state.deferredAskId = null
      return
    }
    if (this.state.ask?.id === next.id && this.state.screen === 'ask') return
    if (this.state.screen === 'voice' || this.state.screen === 'direct') {
      this.state.deferredAskId = next.id
      return
    }
    this.openAsk(next)
  }

  private openAsk(item: StewardThreadItem): void {
    if (item.kind !== 'ask') return
    this.state.ask = item
    this.state.askCursor = 0
    this.state.askChecked = []
    this.state.deferredAskId = null
    this.state.screen = 'ask'
  }

  /** Where the ring goes once a question is done with. Back to the session it
   *  was about when there is one - that is where the answer's consequences show
   *  up - and to the list otherwise. */
  private leaveAsk(): void {
    const about = this.state.ask?.sessionId
    this.state.ask = null
    if (about && this.state.sessions.some((s) => s.id === about)) this.openSession(about)
    else this.toOverview()
  }

  private async answerAsk(answer: Parameters<typeof replyToSteward>[0]['answer']): Promise<void> {
    const ask = this.state.ask
    if (ask?.kind !== 'ask') return
    // Left before the request rather than after: a wearer who has answered
    // should not be looking at the question while the round trip happens, and
    // the server's copy is authoritative either way.
    this.leaveAsk()
    this.render()
    try {
      await replyToSteward({ askId: ask.ask.id, answer, sessionId: ask.sessionId })
    } catch {
      /* the thread is the record; a failed post is visible as the question
         coming back on the next push */
    }
  }

  // ── navigation ──

  toOverview(): void {
    this.state.screen = 'overview'
    this.state.openSessionId = null
    this.state.directText = ''
    this.ws.unsubscribeSession()
    this.presentPendingAsk()
  }

  openSession(sessionId: string): void {
    this.state.screen = 'session'
    this.state.openSessionId = sessionId
    this.state.sessionPage = 0
    this.state.sessionWaiting = false
    void this.loadSession(sessionId)
  }

  /**
   * The steward's version of a session, asking for one if it has not written it.
   *
   * Falling back to the raw transcript is what this refuses. `update_session`
   * writes differences, so a session that is never asked for is never
   * summarised - showing the raw thing instead would make that permanent, and
   * the raw thing paged seven lines at a time is the experience this whole app
   * exists to replace.
   */
  private async loadSession(sessionId: string): Promise<void> {
    try {
      const { turns } = await getSessionTurns(sessionId)
      if (this.state.openSessionId !== sessionId) return
      this.state.turns.set(sessionId, turns)
      if (turns.length === 0) {
        this.state.sessionWaiting = true
        this.render()
        await summariseSession(sessionId)
        // The writing arrives as `steward-turns`, which clears the wait.
      }
      this.render()
    } catch {
      this.state.sessionWaiting = false
      this.render()
    }
  }

  private openDirect(): void {
    const sessionId = this.state.openSessionId
    if (!sessionId) return
    this.state.screen = 'direct'
    this.state.directPage = 0
    this.state.directText = ''
    this.ws.subscribeSession(sessionId)
    void this.loadDirectTranscript(sessionId)
  }

  /**
   * The raw conversation, for the one screen that shows it.
   *
   * Both sources: the pane's live text arrives over the socket, and the
   * transcript fills in what is above it. A pane that has scrolled past its own
   * output shows nothing otherwise, which reads as an empty session.
   */
  private async loadDirectTranscript(sessionId: string): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === sessionId)
    const agentSession = session?.agentSessionId ?? session?.panes?.find((p) => p.agentSessionId)?.agentSessionId
    if (!agentSession) return
    const messages = await getConversation(agentSession, 6, threadAgentOf(session?.agent))
    if (this.state.openSessionId !== sessionId || this.state.screen !== 'direct') return
    if (this.state.directText) return
    this.state.directText = messages
      .map((m) => `${m.role === 'user' ? 'you' : 'agent'}: ${m.content}`)
      .join('\n')
    this.render()
  }

  private toReport(): void {
    this.state.screen = 'report'
    this.state.reportCursor = 0
  }

  // ── ring ──

  tap(): void {
    switch (this.state.screen) {
      case 'overview':
        this.overviewTap()
        break
      case 'session':
        this.sessionTap()
        break
      case 'ask':
        this.askTap()
        break
      case 'report':
        this.reportTap()
        break
      case 'voice':
        void this.voiceTap()
        break
      case 'direct':
        this.startVoice({ kind: 'pane', sessionId: this.state.openSessionId ?? '' })
        break
    }
    this.render()
  }

  doubleTap(): void {
    switch (this.state.screen) {
      case 'overview':
        // Fixed by the Hub's review requirements, and the one gesture in this
        // app that does not mean "go back". A root has nowhere further up.
        this.platform.requestExit()
        return
      case 'session':
        this.toOverview()
        break
      case 'ask':
        // Walking away is an answer. Without it the steward waits forever on a
        // question nobody intends to answer.
        void this.answerAsk({ kind: 'dismissed' })
        return
      case 'report':
        this.toOverview()
        break
      case 'voice':
        this.cancelVoice()
        break
      case 'direct':
        this.state.screen = 'session'
        this.ws.unsubscribeSession()
        this.presentPendingAsk()
        break
    }
    this.render()
  }

  swipeUp(): void {
    this.move(-1)
  }

  swipeDown(): void {
    this.move(1)
  }

  private move(delta: number): void {
    switch (this.state.screen) {
      case 'overview': {
        const rows = overviewRows(this.state).length
        if (rows > 0) this.state.cursor = clamp(this.state.cursor + delta, 0, rows - 1)
        break
      }
      case 'session': {
        const pages = sessionPageCount(this.state)
        // Below zero is the direct row, one step "above" the newest page. It
        // sits there rather than after the oldest so it is one swipe from where
        // the screen opens, and so paging back through history never lands on
        // it by accident.
        this.state.sessionPage = clamp(this.state.sessionPage + delta, -1, Math.max(0, pages - 1))
        break
      }
      case 'ask': {
        const ask = this.state.ask
        if (ask?.kind !== 'ask') break
        const rows = askRows(ask.ask).length
        if (rows > 0) this.state.askCursor = clamp(this.state.askCursor + delta, 0, rows - 1)
        break
      }
      case 'report': {
        const rows = latestReport(this.state.thread)?.kind === 'report' ? this.reportRowCount() : 0
        if (rows > 0) this.state.reportCursor = clamp(this.state.reportCursor + delta, 0, rows - 1)
        break
      }
      case 'direct': {
        const pages = directPages(this.state).length
        if (pages > 0) this.state.directPage = clamp(this.state.directPage + delta, 0, pages - 1)
        break
      }
      case 'voice':
        // A swipe takes back the last phrase, which is the only editing this
        // screen has - and the reason a phrase is drawn as its own line.
        if (this.state.voice?.phase === 'confirm') this.undoPhrase()
        break
    }
    this.render()
  }

  private reportRowCount(): number {
    const report = latestReport(this.state.thread)
    return report?.kind === 'report' ? report.rows.length : 0
  }

  private overviewTap(): void {
    const row = overviewRows(this.state)[this.state.cursor]
    if (!row) return
    if (row.kind === 'say') {
      // The one screen that belongs to no session, so the one place a request
      // that crosses sessions can be made.
      this.startVoice({ kind: 'steward' })
      return
    }
    if (row.kind === 'report') {
      this.toReport()
      return
    }
    this.openSession(row.session.id)
  }

  private sessionTap(): void {
    if (this.state.sessionPage < 0) {
      this.openDirect()
      return
    }
    const sessionId = this.state.openSessionId
    if (sessionId) this.startVoice({ kind: 'steward-session', sessionId })
  }

  private askTap(): void {
    const item = this.state.ask
    if (item?.kind !== 'ask') return
    const ask = item.ask
    const row = askRows(ask)[this.state.askCursor]
    if (!row) return

    if (row.kind === 'send') {
      // Sends whatever is ticked, including nothing. On a multi-select a tap is
      // a toggle, so "none of these" is a decision the wearer can reach and has
      // to be able to send.
      void this.answerAsk({ kind: 'choice', indices: [...this.state.askChecked].sort((a, b) => a - b) })
      return
    }
    if (row.kind === 'speak') {
      this.startVoice({ kind: 'ask', askId: ask.id, sessionId: item.sessionId })
      return
    }
    if (ask.mode === 'multi') {
      this.state.askChecked = this.state.askChecked.includes(row.index)
        ? this.state.askChecked.filter((i) => i !== row.index)
        : [...this.state.askChecked, row.index]
      return
    }
    if (ask.mode === 'freeText') {
      // The server refuses a choice against a free-text question - and rightly:
      // what it asked for is words. Picking a listed one answers in those words.
      void this.answerAsk({ kind: 'text', text: row.label })
      return
    }
    void this.answerAsk({ kind: 'choice', indices: [row.index] })
  }

  private reportTap(): void {
    const report = latestReport(this.state.thread)
    if (report?.kind !== 'report') return
    const row = report.rows[this.state.reportCursor]
    if (!row) return
    const session = sessionOfRow(row, this.state.sessions)
    // A row this app cannot match to a session simply does not open one.
    // Opening the wrong session would be worse, and refusing to draw the row
    // would hide what the steward reported.
    if (session) this.openSession(session.id)
  }

  // ── voice ──

  startVoice(target: VoiceTarget): void {
    this.phrases = []
    this.audioChunks = []
    this.silenceSamples = 0
    this.phraseSamples = 0
    this.heardSpeech = false
    this.state.voice = { phase: 'recording', target, phrases: [], level: 0 }
    this.state.screen = 'voice'
    this.render()

    void this.platform.startMicCapture().then((ok) => {
      if (!ok) {
        this.state.voice = { phase: 'confirm', target, phrases: [], level: 0, error: 'network' }
        this.render()
      }
    })
    this.recordingTimer = setTimeout(() => this.closeRecording(), MAX_RECORDING_MS)
  }

  onAudioData(pcm: Uint8Array): void {
    const voice = this.state.voice
    if (!voice || voice.phase !== 'recording') return
    this.audioChunks.push(pcm)
    this.phraseSamples += pcm.length / 2

    const rms = pcmRms(pcm)
    const level = micLevel(rms)
    if (level !== voice.level && Date.now() - this.levelDrawnAt > LEVEL_REDRAW_MS) {
      this.levelDrawnAt = Date.now()
      voice.level = level
      this.render()
    }

    if (rms >= SPEECH_RMS) {
      this.heardSpeech = true
      this.silenceSamples = 0
      return
    }
    if (!this.heardSpeech) return
    this.silenceSamples += pcm.length / 2
    // A pause under the billing floor is treated as part of the phrase rather
    // than the end of it, which keeps a minute of dictation at about a minute
    // of billed audio instead of two and a half.
    if (this.silenceSamples >= SILENCE_TAIL_SAMPLES && this.phraseSamples >= MIN_PHRASE_SAMPLES) {
      this.closePhrase()
    }
  }

  /** Send what has been collected so far and keep the microphone open. */
  private closePhrase(): void {
    const pcm = concatPcm(this.audioChunks)
    this.audioChunks = []
    this.silenceSamples = 0
    this.phraseSamples = 0
    this.heardSpeech = false
    if (pcm.length === 0) return

    const phrase: DraftPhrase = { text: null, failed: false }
    this.phrases.push(phrase)
    this.syncPhrases()
    this.render()

    void this.platform
      .transcribeAudio(pcm, this.sessionOfVoice())
      .then((text) => {
        phrase.text = text
      })
      .catch(() => {
        phrase.failed = true
      })
      .finally(() => {
        this.syncPhrases()
        this.render()
      })
  }

  /** The wearer said they are finished: close what is open and go to confirm. */
  private closeRecording(): void {
    const voice = this.state.voice
    if (!voice || voice.phase !== 'recording') return
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer)
      this.recordingTimer = null
    }
    // Not subject to the billing floor: a wearer who has finished has finished.
    if (this.audioChunks.length > 0) {
      this.phraseSamples = MIN_PHRASE_SAMPLES
      this.heardSpeech = true
      this.closePhrase()
    }
    void this.platform.stopMicCapture()
    voice.phase = this.phrases.length > 0 ? 'transcribing' : 'confirm'
    this.syncPhrases()
    this.render()
  }

  /** Mirror the capture's phrases into the state the screen reads. */
  private syncPhrases(): void {
    const voice = this.state.voice
    if (!voice) return
    voice.phrases = this.phrases.map<DraftPhraseView>((p) =>
      p.failed ? { kind: 'lost' } : p.text === null ? { kind: 'pending' } : { kind: 'text', text: p.text },
    )
    if (voice.phase === 'transcribing' && this.phrases.every((p) => p.text !== null || p.failed)) {
      voice.phase = 'confirm'
      // Everything failed rather than everything being silent: the wearer needs
      // to know whether to say it again or wait.
      if (this.phrases.length > 0 && this.phrases.every((p) => p.failed)) voice.error = 'network'
    }
  }

  private undoPhrase(): void {
    this.phrases.pop()
    this.syncPhrases()
  }

  private sessionOfVoice(): string | undefined {
    const target = this.state.voice?.target
    if (!target) return undefined
    // Names who is speaking, which leads the server's vocabulary bias with that
    // session's own words.
    if (target.kind === 'steward-session' || target.kind === 'pane') return target.sessionId
    if (target.kind === 'ask') return target.sessionId
    return undefined
  }

  private async voiceTap(): Promise<void> {
    const voice = this.state.voice
    if (!voice) return
    if (voice.phase === 'recording') {
      this.closeRecording()
      return
    }
    if (voice.phase === 'transcribing') return

    const text = joinPhrases(
      voice.phrases.map((p) => (p.kind === 'text' ? p.text : '')).filter(Boolean),
    )
    if (!text) {
      // Nothing to send: the tap starts again rather than doing nothing.
      this.startVoice(voice.target)
      return
    }
    await this.deliver(voice.target, text)
  }

  /**
   * Where a spoken sentence actually goes.
   *
   * The four destinations are the four ways in, and the screen it was started
   * from is the whole of the addressing - which is why the wearer never picks
   * one and never has to be told which they picked.
   */
  private async deliver(target: VoiceTarget, text: string): Promise<void> {
    const back = () => {
      this.state.voice = null
      this.presentPendingAsk()
      this.render()
    }

    try {
      switch (target.kind) {
        case 'steward':
          await replyToSteward({ text })
          this.state.screen = 'overview'
          break
        case 'steward-session':
          await replyToSteward({ text, sessionId: target.sessionId })
          this.state.screen = 'session'
          break
        case 'ask':
          await replyToSteward({ askId: target.askId, answer: { kind: 'text', text } })
          this.state.ask = null
          this.state.screen = target.sessionId ? 'session' : 'overview'
          break
        case 'pane': {
          const session = this.state.sessions.find((s) => s.id === target.sessionId)
          const paneId = target.paneId ?? session?.panes?.find((p) => p.isActive)?.paneId
          await sendPrompt(target.sessionId, text, paneId)
          // Told to the steward as well as to the agent. Unrecorded, the pane
          // changes state for a reason the steward cannot account for, and its
          // next summary of this session is written around the gap.
          void reportSpokenDirectly(target.sessionId, text).catch(() => {})
          this.state.screen = 'direct'
          break
        }
      }
    } catch {
      // Kept on screen with what was said still in it, so it can be sent again.
      if (this.state.voice) this.state.voice.error = 'network'
      this.render()
      return
    }
    back()
  }

  private cancelVoice(): void {
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer)
      this.recordingTimer = null
    }
    void this.platform.stopMicCapture()
    const target = this.state.voice?.target
    this.state.voice = null
    this.phrases = []
    this.audioChunks = []
    // Back where it was started from, which is where the wearer's attention
    // already is.
    if (target?.kind === 'pane') this.state.screen = 'direct'
    else if (target?.kind === 'steward-session') this.state.screen = 'session'
    else if (target?.kind === 'ask') this.state.screen = 'ask'
    else this.state.screen = 'overview'
    this.presentPendingAsk()
  }

  // ── lifecycle ──

  /** A canned overview, for a first run with no server. A reviewer has neither
   *  a server nor any intention of installing one, and without this the app
   *  they were asked to judge is a paragraph of instructions. */
  startDemo(): void {
    this.state.demo = true
    this.state.connected = true
    this.state.sessions = [
      { id: 'w1', name: 'work-1' },
      { id: 'w2', name: 'work-2' },
      { id: 'w3', name: 'life' },
    ]
    const at = Date.now()
    this.state.lines = [
      { sessionId: 'w1', text: 'waiting on review   12m', at },
      { sessionId: 'w2', text: 'question unanswered  4m', at },
      { sessionId: 'w3', text: 'done, unread        31m', at },
    ]
    this.state.thread = [
      {
        id: 'demo-report',
        at,
        role: 'steward',
        kind: 'report',
        text: '3 sessions are stuck',
        rows: ['work-1  waiting on review   12m', 'work-2  question unanswered  4m', 'life    done, unread  31m'],
      },
    ]
    this.state.turns.set('w1', [
      {
        id: 'demo-turn',
        at,
        role: 'steward',
        text: 'Seven review comments came back. One of them changes the design, and it is waiting on your call.',
      },
    ])
    this.state.screen = 'overview'
    this.state.cursor = 0
    this.render()
  }

  stopDemo(): void {
    const demo = this.state.demo
    this.state = initialState()
    // `demo` is a flag on the state the real app draws from, so a run that
    // passed through it kept canned rows over live ones for the rest of its
    // life.
    if (demo) void this.refresh()
    this.render()
  }

  onForegroundEnter(): void {
    this.ws.connect()
    void this.refresh()
  }

  onForegroundExit(): void {
    // Nothing to save: everything on these screens is the server's, and it is
    // still there when the app comes back. The other app persists a resume
    // point because it holds scraped state that cannot be asked for again.
  }

  onHostExit(_kind: 'abnormal' | 'system'): void {
    this.stopped = true
    if (this.headerTimer) {
      clearInterval(this.headerTimer)
      this.headerTimer = null
    }
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer)
      this.recordingTimer = null
    }
    void this.platform.stopMicCapture()
    this.ws.close()
  }

  isStopped(): boolean {
    return this.stopped
  }

  private clampCursor(): void {
    const rows = overviewRows(this.state).length
    this.state.cursor = clamp(this.state.cursor, 0, Math.max(0, rows - 1))
  }

  private render(): void {
    if (this.stopped) return
    this.platform.render(this.state)
  }

  /** What the panel is showing, as the server's screen mirror wants it. Only
   *  the device publishes - see `GlassesPlatform.onDevice`. */
  screenFrame(): Record<string, unknown> {
    const { header, body, footer, notice, headerless } = screenText(this.state)
    const session = this.state.sessions.find((s) => s.id === this.state.openSessionId)
    return {
      header,
      body,
      footer,
      notice,
      headerless,
      mode: this.state.screen,
      session: session ? { id: session.id, name: sessionName(session) } : undefined,
      app: __APP_VERSION__,
      appCommit: __BUILD_COMMIT__,
      at: Date.now(),
    }
  }

  /** The draft as it would be sent. For the simulator's diagnostics. */
  draft(): string {
    return this.state.voice ? draftText(this.state.voice.phrases) : ''
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}
