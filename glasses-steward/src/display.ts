// What the panel shows, and how it gets there.
//
// Two halves, and the seam between them is deliberate:
//
//   `screenText(state)`  the strings one screen is made of. Wording lives here
//                        and nowhere else, so the simulator and the device say
//                        the same words
//   `updateDisplay()`    those strings onto the panel, as containers, deciding
//                        each time whether the page has to be rebuilt or can be
//                        upgraded in place
//
// The second half is carried over from the other glasses app almost unchanged.
// It is not clever code, it is measured code: the rebuild-vs-upgrade rule, the
// record of what each container is already showing, and what to do about a host
// that refuses a write were all paid for on hardware.
//
// The first half is new, and smaller than the app it is modelled on for one
// reason: **the steward writes the words**. There is no scraping to undo, no
// choice-key walk to infer, no judgement about whether something deserves the
// screen. Every screen here is a layout over sentences that arrived complete.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import {
  BAR_H,
  BODY_PAD,
  BODY_WIDTH,
  HEADER_PAD,
  HEADER_WIDTH,
  LINE_H,
  LIST_LINES,
  LIST_PAD,
  MAX_LINES,
  SPACE_W,
  clipToWidth,
  ellipsize,
  splitLines,
  textWidth,
} from './metrics.ts'
import { conversationPages } from './conversation.ts'
import { GIVE_UP_AFTER_MS } from './ws-client.ts'
import { lineFor, sessionName } from './types.ts'
import type {
  ConversationMessage,
  Session,
  StewardAsk,
  StewardSessionLine,
  StewardThreadItem,
  StewardTurn,
} from './types.ts'

const W = 576
const H = 288

export type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

/** The six screens of the design, and nothing else. */
export type Screen = 'overview' | 'session' | 'ask' | 'report' | 'voice' | 'direct'

export type VoicePhase = 'recording' | 'transcribing' | 'confirm'

/** One phrase of a draft, as the screen shows it. */
export type DraftPhraseView =
  | { kind: 'text'; text: string }
  | { kind: 'pending' }
  | { kind: 'lost' }

/**
 * Where a spoken sentence is going.
 *
 * The screen it was started from decides this, which is the whole reason the
 * same three phases can serve four destinations without the wearer ever having
 * to pick one: from a session you are talking to the steward about that
 * session, from direct mode you are talking to the agent. One step down is the
 * address.
 */
export type VoiceTarget =
  | { kind: 'steward' }
  | { kind: 'steward-session'; sessionId: string }
  | { kind: 'ask'; askId: string; sessionId?: string }
  | { kind: 'pane'; sessionId: string; paneId?: string }

export interface VoiceState {
  phase: VoicePhase
  target: VoiceTarget
  /** One entry per phrase; `pending` until its transcription answers. */
  phrases: DraftPhraseView[]
  /** Filled cells of the loudness meter, 0 when nothing is being heard. */
  level: number
  /** Set when the last attempt failed for a reason worth telling apart from
   *  silence: a wearer who was heard and not delivered should not say it again
   *  in the same words expecting a different outcome. */
  error?: 'network' | 'nothing'
}

export interface AppState {
  screen: Screen
  /** False until the first frame from the server. Nothing is invented while it
   *  is false - an empty overview is drawn as "connecting", not as "no
   *  sessions", which is a different and alarming thing to be told. */
  connected: boolean

  sessions: Session[]
  lines: StewardSessionLine[]
  thread: StewardThreadItem[]
  turns: Map<string, StewardTurn[]>

  /** overview: index into `overviewRows`. */
  cursor: number

  /** session */
  openSessionId: string | null
  /** Page of the open session's history, newest first. `-1` selects the row
   *  that steps down into direct mode - see `sessionPageCount`. */
  sessionPage: number
  /** The steward has been asked to write this session and has not yet. */
  sessionWaiting: boolean

  /** ask: the question on screen, and where the ring is inside it. */
  ask: StewardThreadItem | null
  askCursor: number
  askChecked: number[]

  /** report */
  reportCursor: number

  /** voice */
  voice: VoiceState | null

  /**
   * direct: the pane's transcript, as the history API sends it.
   *
   * The messages rather than the terminal. What the pane is painting is escape
   * sequences and a redrawing spinner, and seven lines of that is not what
   * anyone stepped down here to read - see `conversation.ts`, which turns these
   * into the format the panel reserves for them.
   */
  direct: ConversationMessage[]
  directPage: number

  /**
   * A question that arrived while the wearer was mid-sentence or one step down
   * in a session.
   *
   * Held rather than shown. Those are the two states an interruption must not
   * take: speaking to a screen that changes under you sends the sentence
   * somewhere you did not choose, and direct mode is the one place someone is
   * deliberately concentrating on a single pane. It becomes a strip at the top
   * instead, and is presented the moment they come back up.
   */
  deferredAskId: string | null

  /** The run is closing itself and says why. */
  fatal?: 'offline'

  /** Canned data, for a first run with no server. */
  demo?: boolean
}

export function initialState(): AppState {
  return {
    screen: 'overview',
    connected: false,
    sessions: [],
    lines: [],
    thread: [],
    turns: new Map(),
    cursor: 0,
    openSessionId: null,
    sessionPage: 0,
    sessionWaiting: false,
    ask: null,
    askCursor: 0,
    askChecked: [],
    reportCursor: 0,
    voice: null,
    direct: [],
    directPage: 0,
    deferredAskId: null,
  }
}

// ─── Text helpers ───

function splitBody(text: string): string[] {
  return splitLines(text, BODY_WIDTH)
}

export function wrapForPanel(text: string): string {
  return text.split('\n').flatMap(splitBody).join('\n')
}

/**
 * The line as it stands, or ellipsized when it genuinely does not fit.
 *
 * `ellipsize` always appends its mark, which on a line that already fits is the
 * app claiming something was cut when nothing was - and a wearer who reads a
 * trailing dot as "there is more of this" has been told a lie by the layout.
 */
function fit(line: string, px: number = BODY_WIDTH): string {
  return textWidth(line) <= px ? line : ellipsize(line, px)
}

/** The head, and a right-parked tail. The head yields if the two do not fit. */
function layOut(head: string, tail: string): string {
  const tailPx = tail ? textWidth(tail) : 0
  const gap = tail ? SPACE_W : 0
  const build = (h: string, spaces: number) => `${h}${' '.repeat(spaces)}${tail}`
  let title = head
  while (title && textWidth(title) + gap + tailPx > HEADER_WIDTH) title = title.slice(0, -1)
  let spaces = tail ? Math.max(1, Math.floor((HEADER_WIDTH - textWidth(title) - tailPx) / SPACE_W)) : 0
  let out = build(title, spaces)
  // Kerning across the join can cost a pixel or two; give it back rather than
  // hand the container a line it has to wrap.
  while (spaces > 1 && textWidth(out) > HEADER_WIDTH) {
    spaces--
    out = build(title, spaces)
  }
  while (title && textWidth(out) > HEADER_WIDTH) {
    title = title.slice(0, -1)
    out = build(title, spaces)
  }
  return out
}

function clock(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

const CURSOR = '>'
const NO_CURSOR = ' '

/**
 * The mark on a row that does something other than open what it names.
 *
 * A different glyph from the cursor on purpose: with both drawn as `>` a
 * selected action row read `> > Send`, which looks like a rendering fault
 * rather than a selection. `→` is a mark the firmware actually carries - it is
 * one of the substitution *targets* in `metrics.ts`, so it is known to have an
 * advance rather than hoped to.
 */
const ACTION = '→'

function mark(selected: boolean): string {
  return selected ? `${CURSOR} ` : `${NO_CURSOR} `
}

// ─── The strip that holds a deferred question ───

/**
 * The one thing that appears over a screen without taking it.
 *
 * A question that arrived while the wearer was speaking or one step down in a
 * session is not shown - it is announced. Which is the app's own judgement and
 * the only one it makes: the server decided the question deserves attention,
 * and only this side knows that right now would be the wrong moment.
 */
export function deferredNotice(state: AppState): string {
  if (!state.deferredAskId) return ''
  return 'A question is waiting'
}

// ─── overview ───

export type OverviewRow =
  | { kind: 'session'; session: Session; line?: string }
  | { kind: 'report'; text: string }
  | { kind: 'say' }

/**
 * Every session, plus the two rows that are not sessions.
 *
 * **Nothing is filtered out.** Which sessions are worth looking at is the
 * steward's judgement and it expresses it in the order and in what each line
 * says - not by hiding rows. A list that drops what it thinks is uninteresting
 * cannot answer "what happened to that one", which is most of what a list is
 * for. Narrowing is the report screen's job.
 *
 * The order is the server's, which is herdr's workspace order - the same order
 * the phone's list uses. When the steward is allowed to reorder workspaces it
 * will move them there, and both screens will follow without either learning a
 * new rule.
 */
export function overviewRows(state: AppState): OverviewRow[] {
  const rows: OverviewRow[] = state.sessions.map((session) => ({
    kind: 'session',
    session,
    line: lineFor(state.lines, session.id),
  }))
  const report = latestReportOf(state)
  if (report) rows.push({ kind: 'report', text: report.text })
  rows.push({ kind: 'say' })
  return rows
}

function latestReportOf(state: AppState): (StewardThreadItem & { kind: 'report' }) | undefined {
  for (let i = state.thread.length - 1; i >= 0; i--) {
    const item = state.thread[i]
    if (item?.kind === 'report') return item
  }
  return undefined
}

/** What the steward's line is indented by, under the name it belongs to. */
const ROW_INDENT = '    '

/**
 * One session, over two lines.
 *
 * Both halves were on one line to begin with, in columns - and both were
 * crushed. A workspace label here runs to forty characters and the steward's
 * line is a sentence, so a 564px row gave each of them a third of what it
 * needed and clipped the rest: the name said `端末Chrome…` and the line said
 * `レビュー待…`, which is two things unreadable instead of one thing read.
 *
 * Half as many sessions fit on a page now, and that is the trade. The list is
 * still whole - swiping reaches every session, and which ones come first is
 * the steward's judgement - but what is on screen can be read rather than
 * decoded.
 *
 * A session the steward has not written about takes one line, not two: an
 * empty second line spends the budget on saying nothing.
 */
function overviewRowLines(row: OverviewRow, selected: boolean): string[] {
  const cursor = mark(selected)
  if (row.kind === 'say') return [`${cursor}${ACTION} Talk to the steward`]
  if (row.kind === 'report') {
    return [`${cursor}${fit(`${row.text} ${ACTION}`, BODY_WIDTH - textWidth(cursor))}`]
  }
  const name = fit(`${cursor}${sessionName(row.session)}`)
  // Nothing written is drawn as nothing rather than as a recap or a status:
  // half a list in the steward's words and half in scraped ones reads as
  // neither.
  if (!row.line) return [name]
  return [name, fit(`${ROW_INDENT}${row.line}`)]
}

/**
 * Which row the window starts at, when rows are not all the same height.
 *
 * `windowStart` counts rows and cannot be used here: a two-line session and a
 * one-line action row spend different amounts of the nine lines there are. The
 * cursor's row is always whole, about half the budget is kept above it so what
 * came before is still visible, and at the end of the list the window is
 * pulled back rather than left half empty.
 */
export function overviewStart(heights: number[], cursor: number, budget: number): number {
  const half = Math.floor(budget / 2)
  let start = Math.max(0, Math.min(cursor, heights.length - 1))
  let above = 0
  while (start > 0 && above + (heights[start - 1] ?? 1) <= half) {
    start--
    above += heights[start] ?? 1
  }
  let used = above + (heights[cursor] ?? 1)
  for (let i = cursor + 1; i < heights.length && used + (heights[i] ?? 1) <= budget; i++) {
    used += heights[i] ?? 1
  }
  while (start > 0 && used + (heights[start - 1] ?? 1) <= budget) {
    start--
    used += heights[start] ?? 1
  }
  return start
}

function overviewBody(state: AppState): string {
  if (!state.connected) return 'Connecting...'
  const rows = overviewRows(state)
  const drawn = rows.map((row, i) => overviewRowLines(row, i === state.cursor))
  const start = overviewStart(drawn.map((lines) => lines.length), state.cursor, LIST_LINES)

  const out: string[] = []
  for (let i = start; i < drawn.length; i++) {
    const lines = drawn[i] ?? []
    // A row is drawn whole or not at all: half a session is a name with
    // somebody else's line under it.
    if (out.length + lines.length > LIST_LINES) break
    out.push(...lines)
  }
  return out.join('\n')
}

/** Keep the cursor on screen without moving the window more than it has to. */
export function windowStart(cursor: number, total: number, room: number): number {
  if (total <= room) return 0
  return Math.max(0, Math.min(cursor - Math.floor(room / 2), total - room))
}

function overviewFooter(state: AppState): string {
  const rows = overviewRows(state)
  const position = rows.length > 0 ? `${Math.min(state.cursor + 1, rows.length)}/${rows.length}` : ''
  return layOut('swipe:move  tap:open  dbl:exit', `${position}  ${clock()}`)
}

// ─── session ───

/**
 * The open session's history, a page at a time, newest first.
 *
 * One turn per page rather than a scroll of everything: a turn is one thing the
 * steward decided was worth saying, and running two of them together on one
 * page is how a summary turns back into a feed.
 */
export function sessionPages(state: AppState): string[][] {
  const id = state.openSessionId
  if (!id) return []
  const turns = state.turns.get(id) ?? []
  const room = MAX_LINES - 1 // the direct row keeps the last line
  const pages: string[][] = []
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (!turn) continue
    // What the wearer said is marked as theirs. Unmarked, an instruction they
    // gave an hour ago reads as the steward reporting it back to them.
    const text = turn.role === 'user' ? `You: ${turn.text}` : turn.text
    const lines = splitBody(text)
    for (let at = 0; at < lines.length; at += room) {
      pages.push(lines.slice(at, at + room))
    }
  }
  return pages
}

export function sessionPageCount(state: AppState): number {
  return sessionPages(state).length
}

/** The row that steps down into direct mode, and whether the ring is on it. */
export const DIRECT_ROW = `${ACTION} Talk to this session directly`

function sessionBody(state: AppState): string {
  const pages = sessionPages(state)
  const onDirect = state.sessionPage < 0
  const page = pages[Math.max(0, state.sessionPage)] ?? []
  const lines = [...page]
  if (lines.length === 0) {
    lines.push(
      state.sessionWaiting
        ? 'The steward is reading this session...'
        : 'Nothing written about this session yet.',
    )
  }
  // The direct row is pinned to the bottom whatever the page holds, so it is in
  // the same place every time and a wearer never has to look for it.
  while (lines.length < MAX_LINES - 1) lines.push('')
  lines.push(`${mark(onDirect)}${DIRECT_ROW}`)
  return lines.join('\n')
}

function sessionHeader(state: AppState): string {
  const session = state.sessions.find((s) => s.id === state.openSessionId)
  const pages = sessionPageCount(state)
  const position = pages > 1 && state.sessionPage >= 0 ? `${state.sessionPage + 1}/${pages}` : ''
  return layOut(session ? sessionName(session) : (state.openSessionId ?? ''), `${position} ${clock()}`.trim())
}

function sessionFooter(state: AppState): string {
  if (state.sessionPage < 0) return 'swipe:back  tap:go direct  dbl:list'
  return 'swipe:page  tap:speak  dbl:list'
}

// ─── ask ───

export type AskRow =
  | { kind: 'choice'; index: number; label: string }
  | { kind: 'send' }
  | { kind: 'speak' }

/**
 * What the ring walks on a question.
 *
 * `send` and `speak` are the app's own rows, not the steward's choices, and
 * indexing is against this list rather than against `choices` - the bug the
 * other app kept re-finding was a walk over one list being answered against
 * another.
 */
export function askRows(ask: StewardAsk): AskRow[] {
  const rows: AskRow[] = ask.choices.map((label, index) => ({ kind: 'choice', index, label }))
  // A multi-select needs three verbs where a single pick needs two - check,
  // send, leave - and there are only two gestures left once double-tap is spoken
  // for. So the third becomes a row.
  if (ask.mode === 'multi') rows.push({ kind: 'send' })
  // Free text keeps its choices selectable: picking one is answering in those
  // words, which the server takes as text. The extra row is for saying
  // something that is not on the list.
  if (ask.mode === 'freeText') rows.push({ kind: 'speak' })
  return rows
}

function askRowText(row: AskRow, state: AppState, selected: boolean, mode: StewardAsk['mode']): string {
  const cursor = mark(selected)
  if (row.kind === 'send') return `${cursor}${ACTION} Send`
  if (row.kind === 'speak') return `${cursor}${ACTION} Say it myself`
  if (mode === 'multi') {
    const box = state.askChecked.includes(row.index) ? '[x]' : '[ ]'
    return fit(`${cursor}${box} ${row.label}`)
  }
  return fit(`${cursor}${row.index + 1} ${row.label}`)
}

/** The question never gets less than this, however many choices there are: a
 *  screen of options with nothing to say what is being decided is not a
 *  question, and there is no gesture on it that reveals one. */
const MIN_QUESTION_LINES = 2

/**
 * Keep `limit` lines, and say so on the last one when there were more.
 *
 * A slice alone ends a sentence mid-word with nothing to mark it, which reads
 * as the steward having written that. The mark is the difference between "this
 * is all of it" and "there is more of this" - and the wearer can only act on
 * the second if they are told.
 */
function clipLines(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines
  const kept = lines.slice(0, limit)
  const last = kept[limit - 1] ?? ''
  kept[limit - 1] = ellipsize(`${last}…`, BODY_WIDTH)
  return kept
}

function askContent(state: AppState): { header: string; body: string; footer: string } {
  const item = state.ask
  if (item?.kind !== 'ask') return { header: '', body: '', footer: '' }
  const about = state.sessions.find((s) => s.id === item.sessionId)
  const step = item.ask.step ? ` (${item.ask.step.index}/${item.ask.step.total})` : ''
  // The name is clipped, not the sentence. `layOut` shortens from the right,
  // and workspace labels here run to forty characters with a status suffix on
  // the end - so the whole of "is asking" was being cut off the bar, leaving a
  // question headed by a session name and no indication it was a question.
  const suffix = ` is asking${step}`
  const who = about
    ? clipToWidth(sessionName(about), HEADER_WIDTH - textWidth(suffix) - textWidth(clock()) - 2 * SPACE_W)
    : 'The steward'
  const header = layOut(`${who}${suffix}`, clock())

  // The choices are served first and the question takes what is left.
  //
  // The other way round loses the answer: a wearer who cannot see the option
  // they are about to confirm is picking blind, while a question one line short
  // of complete is still a question they can act on - and the rest of it is on
  // the phone, which is what `detail` is for. `fitToPage` on the server budgets
  // a whole page for `text`, which is right for a turn and one line too
  // generous for a question that has to share the page with its own answers.
  const rows = askRows(item.ask)
  const room = Math.min(rows.length, MAX_LINES - MIN_QUESTION_LINES - 1)
  const start = windowStart(state.askCursor, rows.length, room)
  const question = clipLines(splitBody(item.text), Math.max(MIN_QUESTION_LINES, MAX_LINES - room - 1))
  const drawn = rows
    .slice(start, start + room)
    .map((row, i) => askRowText(row, state, start + i === state.askCursor, item.ask.mode))

  return {
    header,
    body: [...question, '', ...drawn].join('\n'),
    footer: askFooter(item.ask, state),
  }
}

export function askFooter(ask: StewardAsk, state: AppState): string {
  if (ask.mode === 'multi') {
    const row = askRows(ask)[state.askCursor]
    // The footer says what THIS row's tap does. One promise for the whole
    // screen is the thing that made a picker lie about itself.
    return row?.kind === 'send'
      ? 'swipe:move  tap:send  dbl:later'
      : 'swipe:move  tap:tick  dbl:later'
  }
  if (ask.mode === 'freeText') {
    const row = askRows(ask)[state.askCursor]
    return row?.kind === 'speak'
      ? 'swipe:move  tap:speak  dbl:later'
      : 'swipe:move  tap:answer  dbl:later'
  }
  return 'swipe:select  tap:confirm  dbl:later'
}

// ─── report ───

export function reportRows(state: AppState): string[] {
  const report = latestReportOf(state)
  return report?.kind === 'report' ? report.rows : []
}

function reportContent(state: AppState): { header: string; body: string; footer: string } {
  const report = latestReportOf(state)
  const rows = reportRows(state)
  const room = MAX_LINES
  const start = windowStart(state.reportCursor, rows.length, room)
  const body = rows
    .slice(start, start + room)
    .map((row, i) => fit(`${mark(start + i === state.reportCursor)}${row}`))
    .join('\n')
  return {
    header: layOut(report?.text ?? 'Nothing to report', clock()),
    body: body || 'Nothing is stuck.',
    footer: 'swipe:move  tap:open  dbl:list',
  }
}

// ─── voice ───

/** The loudness scale, as the steps the meter has cells for. */
const LEVEL_STEPS = [150, 250, 420, 600, 1100, 1700, 2400, 3400, 4800, 6800, 9600, 13600]
/** Loud enough to count as speech rather than a room. */
export const SPEECH_RMS = 2400
const QUIET_CELLS = LEVEL_STEPS.indexOf(SPEECH_RMS)

export function micLevel(rms: number): number {
  let level = 0
  for (const step of LEVEL_STEPS) {
    if (rms < step) break
    level++
  }
  return level
}

/** Every cell is one block wide whether lit or not, so the bar does not shift
 *  as a voice moves through it. The divider is where speech begins. */
export function micLevelBar(level = 0): string {
  const cells = LEVEL_STEPS.map((_, i) => (i < level ? '▅' : '▁'))
  return `${cells.slice(0, QUIET_CELLS).join('')}|${cells.slice(QUIET_CELLS).join('')}`
}

/** Who a spoken sentence would reach, in the words the wearer needs. */
export function voiceTargetLabel(target: VoiceTarget, sessions: Session[]): string {
  const named = (id: string) => {
    const session = sessions.find((s) => s.id === id)
    return session ? sessionName(session) : id
  }
  switch (target.kind) {
    case 'steward':
      return 'the steward'
    case 'steward-session':
      return `the steward, about ${named(target.sessionId)}`
    case 'ask':
      return 'your answer'
    case 'pane':
      return `${named(target.sessionId)}, directly`
  }
}

export function draftText(phrases: DraftPhraseView[]): string {
  return phrases
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim()
}

function draftLines(phrases: DraftPhraseView[]): string[] {
  return phrases.flatMap((phrase) => {
    if (phrase.kind === 'text' && !phrase.text) return []
    const body = phrase.kind === 'text' ? phrase.text : phrase.kind === 'pending' ? '...' : '(lost)'
    // The leading mark is what survives wrapping: a long phrase covers several
    // lines and only the marked one starts a phrase, which is what a swipe
    // takes back.
    return splitBody(`- ${body}`)
  })
}

function voiceContent(state: AppState): { header: string; body: string; footer: string } {
  const voice = state.voice
  if (!voice) return { header: '', body: '', footer: '' }
  const to = voiceTargetLabel(voice.target, state.sessions)
  const header = layOut(`To ${to}`, `[${voice.phase}] ${clock()}`)

  if (voice.phase === 'recording') {
    return {
      header,
      body: [
        'Recording',
        '',
        'Speak. It stops when you do,',
        'or after 30 seconds.',
        '',
        micLevelBar(voice.level),
      ].join('\n'),
      footer: 'tap:stop and send  dbl:cancel',
    }
  }

  if (voice.phase === 'transcribing') {
    return { header, body: 'Transcribing...', footer: 'dbl:cancel' }
  }

  // Nothing heard and nothing delivered are different failures, and the wearer
  // does something different about each: say it again, or wait.
  if (voice.error === 'network') {
    return {
      header,
      body: ['Could not reach the server.', 'The recording was not the problem.'].join('\n'),
      footer: 'tap:try again  dbl:cancel',
    }
  }
  const lines = draftLines(voice.phrases)
  return {
    header,
    body: lines.length > 0 ? lines.slice(0, MAX_LINES).join('\n') : '(nothing was recognized)',
    footer: lines.length > 0 ? 'tap:send  swipe:undo  dbl:cancel' : 'tap:record again  dbl:cancel',
  }
}

// ─── direct ───

/**
 * Lines this screen's body actually draws, once a notice has taken its share.
 *
 * Paging by the panel's height while drawing fewer lines is a hole at every
 * page boundary: the body clips its tail, the next page begins past it, and
 * what is in between is on no page at all with nothing on screen to say a line
 * was skipped. The other app paid for that one twice.
 */
function directLines(state: AppState): number {
  const notice = deferredNotice(state)
  const lines = notice ? notice.split('\n').length : 0
  const body = H - 2 * BAR_H - noticeHeight(lines)
  return Math.max(1, Math.floor((body - 2 * BODY_PAD) / LINE_H))
}

export function directPages(state: AppState): string[][] {
  return conversationPages(state.direct, directLines(state))
}

/**
 * What the pane is doing, in the space a badge has.
 *
 * The terminal shows this without being asked - a spinner, or a prompt sitting
 * there waiting - and a transcript alone cannot say which of the two a silence
 * is. `[!]` is the one that changes what the wearer does next, so it is the one
 * spelled out.
 */
function paneBadge(session: Session | undefined): string {
  const pane = session?.panes?.find((p) => p.agent && p.isActive) ?? session?.panes?.find((p) => p.agent)
  const state = pane?.indicatorState ?? session?.indicatorState
  if (state === 'waiting_input') return '[!]'
  if (state === 'processing') return '...'
  return ''
}

function directContent(state: AppState): { header: string; body: string; footer: string } {
  const session = state.sessions.find((s) => s.id === state.openSessionId)
  const pages = directPages(state)
  const page = pages[state.directPage] ?? []
  const position = pages.length > 1 ? `${state.directPage + 1}/${pages.length}` : ''
  const badge = paneBadge(session)
  return {
    header: layOut(
      `${session ? sessionName(session) : ''} · direct${badge ? ` ${badge}` : ''}`,
      `${position} ${clock()}`.trim(),
    ),
    body: page.length > 0 ? page.join('\n') : 'Nothing on this pane yet.',
    footer: 'swipe:page  tap:speak  dbl:up',
  }
}

// ─── the whole screen ───

export interface ScreenText {
  header: string
  body: string
  footer: string
  /** A strip above the body, with a rule under it on the device. Only ever the
   *  deferred question - see `deferredNotice`. */
  notice?: string
  /** The overview gives its header bar back to the list, so its body starts at
   *  the top of the panel. A renderer that ignores this draws a row lower than
   *  the device does. */
  headerless?: boolean
}

/**
 * The last thing a run draws before it closes itself.
 *
 * English, like everything this panel draws. Headerless and footerless: there
 * is nothing left to navigate to, and a footer offering gestures that no longer
 * work is worse than none.
 */
function fatalScreen(): ScreenText {
  const minutes = Math.round(GIVE_UP_AFTER_MS / 60_000)
  return {
    header: '',
    headerless: true,
    footer: '',
    // No blank lines: an empty string does not survive the render, so spacing
    // written that way exists only in this file.
    body: [
      'Cannot reach the server.',
      `Tried for ${minutes} minutes.`,
      `Start ${__PRODUCT_NAME__} on the machine`,
      'it runs on, and check the address',
      'in the phone app.',
      'Closing to free the glasses.',
    ].join('\n'),
  }
}

export function screenText(state: AppState): ScreenText {
  if (state.fatal) return fatalScreen()
  const notice = deferredNotice(state) || undefined
  switch (state.screen) {
    case 'overview':
      return {
        header: '',
        headerless: true,
        body: overviewBody(state),
        footer: overviewFooter(state),
      }
    case 'session':
      return {
        header: sessionHeader(state),
        body: sessionBody(state),
        footer: sessionFooter(state),
        notice,
      }
    case 'ask': {
      const { header, body, footer } = askContent(state)
      return { header, body, footer }
    }
    case 'report': {
      const { header, body, footer } = reportContent(state)
      return { header, body, footer }
    }
    case 'voice': {
      const { header, body, footer } = voiceContent(state)
      return { header, body, footer, notice }
    }
    case 'direct': {
      const { header, body, footer } = directContent(state)
      return { header, body, footer, notice }
    }
  }
}

// ─── Containers ───

/**
 * One builder for every screen.
 *
 * The other app grew a `build*` per mode and they drifted into six copies of
 * the same four containers with different ids. Here the ids fall out of what is
 * present - header, notice, body, footer, in that order - so `updateDisplay`
 * can address them by looking at the same three facts the builder did.
 */
const NOTICE_PAD = 2
const NOTICE_BORDER = 1
const NOTICE_BORDER_COLOR = 6

/** How tall a notice strip of `lines` rows is, borders and padding included.
 *  Exported because the canvas painter has to put its rule in the same place. */
export function noticeHeight(lines: number): number {
  return lines === 0 ? 0 : lines * LINE_H + 2 * NOTICE_PAD + 2 * NOTICE_BORDER
}

export { NOTICE_PAD, NOTICE_BORDER, NOTICE_BORDER_COLOR }

function buildScreen(screen: ScreenText): RebuildPageContainer {
  const objects: InstanceType<typeof TextContainerProperty>[] = []
  let id = 1
  const hasHeader = !screen.headerless
  const noticeLines = screen.notice ? screen.notice.split('\n').length : 0
  const nHeight = noticeHeight(noticeLines)
  const top = hasHeader ? BAR_H : 0

  if (hasHeader) {
    objects.push(
      new TextContainerProperty({
        xPosition: 0, yPosition: 0,
        width: W, height: BAR_H,
        borderWidth: 0,
        paddingLength: HEADER_PAD,
        containerID: id++, containerName: 'header',
        isEventCapture: 0,
        content: screen.header,
      }),
    )
  }

  if (noticeLines > 0) {
    objects.push(
      new TextContainerProperty({
        xPosition: 4, yPosition: top,
        width: W - 8, height: nHeight,
        borderWidth: NOTICE_BORDER,
        borderColor: NOTICE_BORDER_COLOR,
        borderRadius: 0,
        paddingLength: NOTICE_PAD,
        containerID: id++, containerName: 'notice',
        isEventCapture: 0,
        content: screen.notice ?? '',
      }),
    )
  }

  objects.push(
    new TextContainerProperty({
      xPosition: 4, yPosition: top + nHeight,
      width: W - 8, height: H - BAR_H - top - nHeight,
      borderWidth: 0,
      // The list pads tighter than a body does, which is what buys its ninth
      // row - padding it like a body draws eight rows where the device has nine.
      paddingLength: hasHeader ? BODY_PAD : LIST_PAD,
      containerID: id++, containerName: 'body',
      isEventCapture: 0,
      content: screen.body,
    }),
  )

  objects.push(
    new TextContainerProperty({
      xPosition: 0, yPosition: H - BAR_H,
      width: W, height: BAR_H,
      borderWidth: 0,
      paddingLength: HEADER_PAD,
      containerID: id++, containerName: 'footer',
      isEventCapture: 1,
      content: screen.footer,
    }),
  )

  return new RebuildPageContainer({ containerTotalNum: objects.length, textObject: objects })
}

export function buildSetupGuide(): RebuildPageContainer {
  return buildScreen({
    header: `${__PRODUCT_NAME__} Steward`,
    body: [
      'Not connected yet.',
      'Open this app from the Even Hub app',
      'on your phone and enter the address',
      `of the machine ${__PRODUCT_NAME__} runs on.`,
    ].join('\n'),
    footer: 'tap:see how it works                                   dbl:exit',
  })
}

// ─── Display controller ───
//
// From here down is the other glasses app's, carried over because every line of
// it was paid for on hardware. Kept together and kept whole: taking half of it
// is how you end up rediscovering the other half.

/** `StartUpPageCreateResult`, spelled out rather than read off the enum: it is
 *  declared in the SDK's .d.ts and its runtime shape is not ours to rely on. */
const CREATE_RESULT_NAMES: Record<number, string> = {
  0: 'success',
  1: 'invalid',
  2: 'oversize',
  3: 'outOfMemory',
}

/** The geometry last sent. Content alone goes out as in-place upgrades; a
 *  different shape needs the page rebuilt, and these are what say so. */
let currentShape: string | null = null

export async function initDisplay(onBridge?: (bridge: Bridge) => void): Promise<Bridge | null> {
  try {
    const bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bridge timeout')), 5000)),
    ])

    // Runs before the startup container is built, which is the only place a
    // one-shot launch-source subscription can be registered in time: the host
    // pushes it once when loading completes and the SDK keeps no copy.
    try {
      onBridge?.(bridge)
    } catch (e) {
      traceSink?.(`onBridge failed: ${e}`, 'error')
    }

    const initial = new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [
        new TextContainerProperty({
          xPosition: W / 2 - 140, yPosition: H / 2 - 40,
          width: 280, height: 80,
          borderWidth: 2,
          borderColor: 8,
          borderRadius: 5,
          paddingLength: 12,
          containerID: 1, containerName: 'loading',
          isEventCapture: 0,
          content: `${__PRODUCT_NAME__} Steward\nConnecting...`,
        }),
        new TextContainerProperty({
          xPosition: 0, yPosition: H - 28,
          width: W, height: 28,
          containerID: 2, containerName: 'footer',
          isEventCapture: 1,
          content: '',
        }),
      ],
    })

    const created = await Promise.race([
      bridge.createStartUpPageContainer(initial),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('createStartUp timeout')), 3000)),
    ])
    // The host answers this one with a reason, and `outOfMemory` is the answer
    // that would explain a run dying sooner than the one before it.
    traceSink?.(
      `page container created: ${CREATE_RESULT_NAMES[created as number] ?? `unknown(${created})`}`,
      created === 0 ? 'info' : 'error',
    )
    return bridge
  } catch (e) {
    console.log('[display] Even Hub SDK not available - debug mode', e)
    return null
  }
}

/**
 * What each container was last told to show, so an upgrade that would change
 * nothing is not sent at all.
 *
 * Recorded only after the device has taken the write, so a refused upgrade is
 * retried on the next render rather than assumed applied.
 */
const drawn = new Map<number, string>()

let writes = 0
export function panelWrites(): number {
  return writes
}

/**
 * What the host said about the writes we sent it.
 *
 * Every draw call returns a boolean and throwing them away cost more than a log
 * line: `drawn` cached refused content as if it were on screen, so a dropped
 * write became a permanently stale container. Only an explicit `false` counts -
 * the SDK's stubs resolve with nothing.
 */
let drops = 0
export function panelDrops(): number {
  return drops
}

let traceSink: ((message: string, level?: string) => void) | null = null
export function setPanelTrace(fn: (message: string, level?: string) => void): void {
  traceSink = fn
}

const TRACED_DROPS_MAX = 5
let tracedDrops = 0

/**
 * Give up on a panel that keeps saying no.
 *
 * A run of refusals is not a transient failure: the panel is gone, and drawing
 * to it only buys BLE traffic and a log nobody can read. Cleared by
 * `invalidatePanel`, which a foreground re-entry calls - a host that refused us
 * while another app held the display may well accept the next write.
 */
const CONSECUTIVE_DROPS_GIVE_UP = 10
let consecutiveDrops = 0
let gaveUp = false

export function panelGaveUp(): boolean {
  return gaveUp
}

function noteDrop(what: string): void {
  drops++
  consecutiveDrops++
  if (tracedDrops < TRACED_DROPS_MAX) {
    tracedDrops++
    traceSink?.(`host refused ${what} (drop #${drops})`, 'error')
  }
  if (consecutiveDrops >= CONSECUTIVE_DROPS_GIVE_UP && !gaveUp) {
    gaveUp = true
    traceSink?.(
      `host refused ${consecutiveDrops} writes in a row - no longer drawing (drops=${drops})`,
      'error',
    )
  }
}

/** A write the host took. Reaching the panel is what proves it is still ours,
 *  so this is the only thing that resets the run of refusals. */
function noteWrite(count: number): void {
  writes += count
  consecutiveDrops = 0
}

function upgrade(
  bridge: Bridge,
  containerID: number,
  containerName: string,
  content: string,
): Promise<void> | null {
  if (drawn.get(containerID) === content) return null
  return Promise.resolve(
    bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content })),
  ).then((ok) => {
    if (ok === false) {
      noteDrop(`upgrade ${containerName}`)
      return
    }
    noteWrite(1)
    drawn.set(containerID, content)
  })
}

function recordRebuild(container: RebuildPageContainer): void {
  drawn.clear()
  const objects = (container.textObject ?? []) as Array<{ containerID?: number; content?: string }>
  noteWrite(objects.length)
  for (const t of objects) {
    if (typeof t.containerID === 'number') drawn.set(t.containerID, t.content ?? '')
  }
}

/**
 * Forget what the panel is showing, so the next render builds it from nothing.
 *
 * The skip-if-unchanged record is only worth trusting while this app is the
 * only thing writing to the panel. Across a suspend the host may have taken the
 * page down, and a stale record would skip exactly the writes needed to put it
 * back.
 */
function forgetDrawn(): void {
  drawn.clear()
  currentShape = null
}

export function invalidatePanel(): void {
  forgetDrawn()
  // Only here. A refused rebuild also forgets what is on screen, and clearing
  // the run of refusals there meant a host refusing everything never reached
  // the limit - which is precisely the case the limit exists for.
  consecutiveDrops = 0
  gaveUp = false
}

/** The facts `buildScreen` laid the containers out from. A change in any of
 *  them moves an id or a height, which an in-place upgrade cannot do. */
function shapeOf(screen: ScreenText): string {
  const notice = screen.notice ? screen.notice.split('\n').length : 0
  return `${screen.headerless ? 'list' : 'bar'}|${notice}`
}

/** Which container id each part landed on, given the same three facts. */
function idsOf(screen: ScreenText): { header?: number; notice?: number; body: number; footer: number } {
  let id = 1
  const header = screen.headerless ? undefined : id++
  const notice = screen.notice ? id++ : undefined
  return { header, notice, body: id++, footer: id }
}

/**
 * Redraw the header alone.
 *
 * The clock and the position tick change nothing else, and a full update sends
 * four containers where one will do - over BLE, for as long as the app is open.
 */
export async function updateHeader(bridge: Bridge | null, state: AppState): Promise<void> {
  if (!bridge || gaveUp) return
  const screen = screenText(state)
  if (shapeOf(screen) !== currentShape) return
  const ids = idsOf(screen)
  // Headerless screens keep their position and clock in the footer.
  if (ids.header === undefined) await upgrade(bridge, ids.footer, 'footer', screen.footer)
  else await upgrade(bridge, ids.header, 'header', screen.header)
}

export async function updateDisplay(bridge: Bridge | null, state: AppState): Promise<void> {
  if (!bridge || gaveUp) return
  const screen = screenText(state)
  const shape = shapeOf(screen)
  const needsRebuild = shape !== currentShape
  currentShape = shape

  if (needsRebuild) {
    const ok = await bridge.rebuildPageContainer(buildScreen(screen))
    if (ok === false) {
      noteDrop('rebuild')
      // The shape was recorded above on the assumption this would land. Undo
      // it, or the next render sees the geometry as already sent and skips the
      // rebuild, leaving the previous screen up for good. `forgetDrawn` rather
      // than `invalidatePanel`: a refusal is not the host handing the panel
      // back, so it must not clear the run of refusals.
      forgetDrawn()
      return
    }
    recordRebuild(buildScreen(screen))
    return
  }

  const ids = idsOf(screen)
  await Promise.all([
    ...(ids.header === undefined ? [] : [upgrade(bridge, ids.header, 'header', screen.header)]),
    ...(ids.notice === undefined ? [] : [upgrade(bridge, ids.notice, 'notice', screen.notice ?? '')]),
    upgrade(bridge, ids.body, 'body', screen.body),
    upgrade(bridge, ids.footer, 'footer', screen.footer),
  ])
}

// ─── Microphone ───

export async function startMic(bridge: Bridge | null): Promise<boolean> {
  if (!bridge) return false
  try {
    await bridge.audioControl(true, AudioInputSource.Glasses)
    return true
  } catch {
    return false
  }
}

export async function stopMic(bridge: Bridge | null): Promise<void> {
  if (!bridge) return
  try {
    await bridge.audioControl(false, AudioInputSource.Glasses)
  } catch {
    /* going quiet is not worth failing over */
  }
}

// ─── Events ───

/** The host's own account of why it is stopping us. `systemExitReasonCode` is
 *  printed even when zero, because zero is an answer and absent is a different
 *  one - the protobuf omits zero values, so the two arrive identically and only
 *  the raw object separates them. */
function exitDetail(sys: { eventSource?: unknown; systemExitReasonCode?: number } | undefined): string {
  if (!sys) return ''
  const parts = [
    sys.systemExitReasonCode === undefined ? 'reason=absent' : `reason=${sys.systemExitReasonCode}`,
    sys.eventSource === undefined ? '' : `src=${String(sys.eventSource)}`,
  ].filter(Boolean)
  let raw = ''
  try {
    raw = JSON.stringify(sys)
  } catch {
    raw = '(not serialisable)'
  }
  return ` ${parts.join(' ')} sys=${raw.slice(0, 200)}`
}

export function setupEvents(
  bridge: Bridge | null,
  callbacks: {
    onSwipeDown: () => void
    onSwipeUp: () => void
    onTap: () => void
    onDoubleTap: () => void
    onRawEvent?: (raw: string) => void
    onAudioData?: (pcm: Uint8Array) => void
    onForegroundEnter?: () => void
    onForegroundExit?: () => void
    onExit?: (kind: 'abnormal' | 'system', detail?: string) => void
  },
): () => void {
  if (!bridge) return () => {}
  let lastEventTime = 0
  const EVENT_DEBOUNCE = 300

  // Returned rather than dropped: the SDK's unsubscribe is the only way to stop
  // listening, and a handler that outlives the app turns every stray event into
  // work for a page with no display.
  return bridge.onEvenHubEvent((event) => {
    // Mic PCM arrives on the same channel. Its runtime shape depends on the
    // host: Uint8Array, number[], or base64.
    const audio = event.audioEvent?.audioPcm as unknown
    if (audio) {
      let bytes: Uint8Array | null = null
      if (audio instanceof Uint8Array) bytes = audio
      else if (Array.isArray(audio)) bytes = new Uint8Array(audio as number[])
      else if (typeof audio === 'string') {
        const bin = atob(audio)
        const u = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
        bytes = u
      }
      if (bytes && bytes.length) callbacks.onAudioData?.(bytes)
      return
    }

    callbacks.onRawEvent?.(JSON.stringify(event).slice(0, 80))

    const eventType = event.textEvent?.eventType ?? event.sysEvent?.eventType ?? event.listEvent?.eventType
    const sysType = event.sysEvent?.eventType
    const now = Date.now()

    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      if (now - lastEventTime < EVENT_DEBOUNCE) return
      lastEventTime = now
      callbacks.onSwipeUp()
      return
    }
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      if (now - lastEventTime < EVENT_DEBOUNCE) return
      lastEventTime = now
      callbacks.onSwipeDown()
      return
    }

    // Lifecycle before the ring debounce: these are not gestures, and sharing
    // the debounce would have a resume swallow the tap that follows it.
    switch (eventType) {
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        callbacks.onForegroundEnter?.()
        return
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        callbacks.onForegroundExit?.()
        return
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        callbacks.onExit?.('abnormal', exitDetail(event.sysEvent))
        return
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
        callbacks.onExit?.('system', exitDetail(event.sysEvent))
        return
    }

    // Ring tap: sysEvent with undefined eventType.
    if (event.sysEvent && sysType == null && !event.sysEvent.imuData) {
      if (now - lastEventTime > EVENT_DEBOUNCE) {
        lastEventTime = now
        callbacks.onTap()
      }
      return
    }

    if (eventType == null) return
    if (now - lastEventTime < EVENT_DEBOUNCE) return
    lastEventTime = now
    switch (eventType) {
      case OsEventTypeList.CLICK_EVENT:
        callbacks.onTap()
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        callbacks.onDoubleTap()
        break
    }
  })
}
