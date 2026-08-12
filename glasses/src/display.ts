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
  HEADER_PAD,
  BODY_WIDTH,
  CARD_BORDER,
  CARD_BORDER_COLOR,
  CARD_LINES,
  CARD_RADIUS,
  CARD_WIDTH,
  cardBox,
  HEADER_WIDTH,
  LINE_H,
  LIST_LINES,
  LIST_PAD,
  MAX_LINES,
  PANEL_H,
  SPACE_W,
  ellipsize,
  splitLines,
  stripUnrenderable,
  textWidth,
} from './metrics.ts'
// The give-up threshold, so the screen quotes the number the client actually
// uses rather than a copy of it that can drift.
import { GIVE_UP_AFTER_MS } from './ws-client.ts'
import { formatMessage, recapBlockLines } from './types.ts'
import type { Session, Pane, RowMetrics, ConversationMessage, GlassesRelayItem } from './types.ts'

const W = 576
const H = 288

export type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>
type Mode = 'session_list' | 'conversation' | 'choice' | 'voice' | 'overlay'
export type VoicePhase = 'recording' | 'transcribing' | 'confirm'

/** Break text into the lines the body container will show. */
function splitDisplayLines(text: string): string[] {
  return splitLines(text, BODY_WIDTH)
}

/**
 * Paginate a single message by display lines.
 *
 * `lines` is how many the body will actually draw, which is **not** always
 * `MAX_LINES`: a notice takes its share of the panel first, and what is left is
 * `conversationLines(notice)`. Paging by the panel's height while drawing the
 * smaller number tore a hole at every page boundary - the body clipped its
 * tail and the next page began past it, so the lines in between were on no page
 * at all. Recorded on 2026-08-08 with a waiting banner up: a three-proposal
 * answer arrived on the G2 with the whole of the second proposal and the third
 * one's heading missing, page 1 ending mid-list and page 2 resuming after the
 * gap, with nothing to say anything had been skipped.
 */
function paginateSingleMessage(fullText: string, page: number, lines = MAX_LINES): { text: string; pageInfo: string; totalPages: number } {
  const allLines = splitDisplayLines(fullText)
  const perPage = Math.max(1, lines)

  if (allLines.length <= perPage) {
    return { text: fullText, pageInfo: '', totalPages: 1 }
  }

  // Pages tile: no line appears twice. Carrying the last line over as context
  // sounded helpful and read as the page not having advanced — the reader has
  // to work out which of the seven lines is the one they already know.
  const totalPages = Math.ceil(allLines.length / perPage)
  const p = Math.min(page, totalPages - 1)
  const start = p * perPage
  const pageLines = allLines.slice(start, start + perPage)
  const text = pageLines.join('\n')
  const pageInfo = ` p${p + 1}/${totalPages}`
  return { text, pageInfo, totalPages }
}

/** Build multi-message view starting from a specific message index */
function buildMultiMessageViewFrom(msgs: ConversationMessage[], fromIndex: number): { text: string; count: number } {
  if (fromIndex < 0 || msgs.length === 0) return { text: '(no messages)', count: 0 }

  const blocks: string[][] = []
  for (let i = fromIndex; i >= 0; i--) {
    blocks.unshift(splitDisplayLines(formatMessage(msgs[i])))
  }

  const result: string[] = []
  let remaining = MAX_LINES
  let count = 0

  for (let i = blocks.length - 1; i >= 0 && remaining > 0; i--) {
    const lines = blocks[i]
    const needSeparator = result.length > 0 ? 1 : 0
    const linesNeeded = lines.length + needSeparator

    if (linesNeeded <= remaining) {
      if (needSeparator) result.unshift('')
      result.unshift(...lines)
      remaining -= linesNeeded
      count++
    } else if (count === 0) {
      const available = remaining
      const startLine = Math.max(0, lines.length - available)
      result.unshift(...lines.slice(startLine))
      remaining = 0
      count = 1
    } else {
      break
    }
  }

  return { text: result.join('\n'), count }
}

/** Main pagination entry point */
function paginateMessage(msgs: ConversationMessage[], msgIndex: number, page: number, lines = MAX_LINES): { text: string; pageInfo: string; totalPages: number; multiCount: number } {
  if (msgIndex < 0) return { text: '(no messages)', pageInfo: '', totalPages: 0, multiCount: 0 }

  if (page === 0) {
    // Deliberately the panel's own height rather than `lines`: the multi
    // message view has no second page, so packing it smaller drops whole
    // messages instead of moving them, and the tutorial is written to this
    // size. What it packs past the body's share is clipped, which is its own
    // fault to fix and not this one - nothing here is on a page that cannot be
    // reached.
    const { text, count } = buildMultiMessageViewFrom(msgs, msgIndex)
    if (count > 1) {
      return { text, pageInfo: '', totalPages: 1, multiCount: count }
    }
  }

  const fullText = formatMessage(msgs[msgIndex])
  const result = paginateSingleMessage(fullText, page, lines)
  return { ...result, multiCount: 1 }
}

/**
 * Get total pages for the message at a given offset.
 *
 * `lines` must be the number the body will draw with, or the count disagrees
 * with what paging actually does: the footer promises `p1/2` while the reader
 * needs three presses to reach the end, and the last press appears to do
 * nothing.
 */
export function getTotalPagesAt(msgs: ConversationMessage[], offset: number, lines = MAX_LINES): number {
  const msgIndex = msgs.length > 0 ? Math.max(0, msgs.length - 1 - offset) : -1
  if (msgIndex < 0) return 0
  const { totalPages } = paginateMessage(msgs, msgIndex, 0, lines)
  return totalPages
}

/** The text of one page, built the way the body builds it. Exported for the
 *  tests, which check that paging a message loses none of it. */
export function conversationPageText(msgs: ConversationMessage[], offset: number, page: number, lines = MAX_LINES): string {
  const msgIndex = msgs.length > 0 ? Math.max(0, msgs.length - 1 - offset) : -1
  return paginateMessage(msgs, msgIndex, page, lines).text
}

/** Calculate how many messages are shown at a given offset, for offset jumping */
export function getMultiCountAt(msgs: ConversationMessage[], offset: number): number {
  const msgIndex = msgs.length > 0 ? Math.max(0, msgs.length - 1 - offset) : -1
  if (msgIndex < 0) return 1
  const { count } = buildMultiMessageViewFrom(msgs, msgIndex)
  return Math.max(1, count)
}

export interface AppState {
  mode: Mode
  sessions: Session[]
  sessionIndex: number
  conversation: ConversationMessage[]
  conversationOffset: number
  conversationPage: number
  conversationLastLoaded: number
  conversationHasMore: boolean
  conversationLoading: boolean
  choiceIndex: number
  choiceOptions: string[]
  /**
   * What each option says about itself, index-aligned with `choiceOptions`.
   *
   * Drawn under the rows for whichever option the ring is resting on, rather
   * than on the row: a row is one line and gets cut at the panel edge, so a
   * description carried there was readable for about four characters. Absent
   * for a locally scraped picker and for an older server, and then the rows are
   * all there is - which is what the picker was until 0.0.67.
   */
  choiceDetails?: string[]
  /**
   * The options are checkboxes rather than a single pick.
   *
   * Claude Code's multi-select answers to space-then-enter, and the ring had
   * no way to send a space - so tapping sent Enter over an empty set and the
   * question came back unanswered. Where this is set, tap toggles and
   * double-tap sends.
   */
  choiceMulti?: boolean
  /**
   * The options are drawn side by side and answered by moving the pane's own
   * cursor, rather than each having a key of its own.
   *
   * OpenCode's permission prompt is the case: `Allow once  Allow always
   * Reject` on one row, moved with the arrow keys and confirmed with Enter.
   * Carries where that cursor is *now*, re-read from the pane's colours on
   * every pass - which is what makes moving it safe, and what 0.0.52 did not
   * have when it removed cursor-driving for drifting out of step.
   */
  choiceInline?: { options: string[]; selected: number }
  /**
   * Running on canned data with no server behind it.
   *
   * Every screen says so. A demo that could be mistaken for a connected app
   * would fail the same first-run rule it exists to satisfy - the reviewer has
   * to be able to tell that setup is still outstanding.
   */
  demo?: boolean
  /** Pane the cursor is on, when the list row is a pane rather than its
   *  workspace. Carries into the conversation: its own agent session, its own
   *  status, and the pane replies are routed to. */
  selectedPaneId?: string
  /** Whether the list cursor is on the notifications row rather than on a
   *  session. Kept separately because the cursor's position is otherwise
   *  expressed as a session and a pane, and that row is neither. */
  listOnNotifications?: boolean
  /**
   * The run is ending on its own, and why.
   *
   * Read before `mode`, because none of the modes are true any more — the list
   * behind it is whatever the panel last showed, and its cursor no longer goes
   * anywhere. Kept as a reason rather than a sentence so the wording stays in
   * this file with the rest of what the panel says.
   */
  fatal?: 'offline'
  /** Advances one frame per spinner tick while the shown session is working.
   *  Absent in states built before the spinner existed; treated as 0. */
  spinnerTick?: number
  /**
   * How far an over-long notice has scrolled, in lines.
   *
   * The recap and the waiting banner are capped at three lines because that is
   * what the panel can spare, and the rest used to end at `…` — information
   * the reader was told existed and then could not reach. The auto-advance
   * clock scrolls this instead, so waiting is enough to see all of it.
   */
  noticeWindow?: number
  debugEvent?: string
  voicePhase?: VoicePhase
  voiceText?: string
  /**
   * The transcription never came back, as distinct from coming back empty.
   *
   * Both used to read "(nothing was recognized)", and one of them is worth
   * saying again more slowly while the other is worth saying again at all
   *. A request cut off mid-upload - which is what a 10-second HTTP
   * timeout was doing to long recordings on a slow link - looked exactly like
   * a clear recording of silence.
   */
  voiceFailed?: boolean
  // ── Glasses relay channel ──
  /** Active waiting items, priority order (first = shown in the overlay). */
  /**
   * What the wearer just answered, and until when to say so.
   *
   * A scraped question belongs to the pane's blocked epoch, so the app does
   * not take it down on an answer - the server does, once it sees the pane
   * move. That is right, but it leaves the moment that matters silent: the
   * ring sends the key, the same question stays on the strip for a beat, and
   * then it vanishes without ever saying what went. Reported from the device
   * on 2026-08-07 as not being able to tell whether the pick had gone through.
   *
   * So the strip says it. Not a claim that the agent received anything - only
   * that this is what was sent, which is the part the app knows.
   */
  answered?: { text: string; until: number }
  relayWaiting: GlassesRelayItem[]
  /** Active info items, newest first (passive FYI line in conversation). */
  relayInfo: GlassesRelayItem[]
  /** Item presented in 'overlay' mode; null elsewhere. */
  overlayItemId: string | null
  /** Display label of the choice/voice target session (falls back to the id). */
  choiceSessionName?: string
  voiceSessionName?: string
}

// ─── Microphone control (glasses mic → raw PCM via onEvenHubEvent) ───

export async function startMic(bridge: Bridge | null): Promise<boolean> {
  if (!bridge) return false
  try {
    return await bridge.audioControl(true, AudioInputSource.Glasses)
  } catch {
    return false
  }
}

export async function stopMic(bridge: Bridge | null): Promise<void> {
  if (!bridge) return
  try {
    await bridge.audioControl(false)
  } catch { /* ignore */ }
}

function sName(s: Session): string {
  return s.customTitle || s.name || s.id.slice(0, 8)
}

/**
 * Park a wall clock at the right edge of a header.
 *
 * The padding is spaces, and a space is 5px on this panel — a fifth of what a
 * column-counting model assumed, which is why the clock used to stop near the
 * middle. Widths come from the firmware's own metrics now, so the gap is
 * computed in pixels and verified before it goes out.
 *
 * A long title is clipped rather than pushing the clock off: the time is the
 * part that has to stay put to be readable at a glance. Overflow is never an
 * option — the header container is 28px of inner height against a 27px line,
 * so a wrap takes the second line, and the clock with it, off the panel.
 *
 * No timer drives this: the server pushes `sessions-updated` every five
 * seconds and each push re-renders, so the minute is never stale.
 */
/**
 * A title against the right-edge clock, in the one line the bar has.
 *
 * `tail` is what the bar is there to report — a status, a count of what
 * arrived — and it survives a full bar. The title gives way instead: it names
 * where the reader already is, which they can see from everything below it.
 * Without the split a long workspace name would push the new information off
 * the edge, silently, which is the one thing a notice must not do.
 */
/**
 * The mark every demo screen carries.
 *
 * It rides as the bar's tail, which is the one part that never yields - the
 * title is clipped before it and the clock steps aside for it. A demo the
 * wearer could mistake for a connected app would fail the first-run rule it
 * exists to satisfy, so this is not allowed to be the thing that falls off.
 */
const DEMO_TAIL = '  DEMO'

function withClock(title: string, tail = ''): string {
  const now = new Date()
  // The date rides with the time. A wearer reading a session list has often
  // been away from it for longer than a clock can say - `06:38` is the same
  // string whichever morning it is, and the question the panel was being asked
  // was which one. ISO order rather than a locale's: the panel draws English,
  // and this way the fields never swap meaning on the reader.
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

  // What the bar gives up first, in order.
  //
  // The clock used to be the thing that always survived and the title was
  // clipped to make room. Adding the date turned that from a rounding error
  // into a real cost - it took the right-hand side from 52px to 173px, so a
  // workspace name that fitted yesterday loses ten characters today. And the
  // trade is the wrong way round: the title says which session is being read,
  // which is the question, while the date answers one that is usually not
  // being asked.
  //
  // So the title is served first and the clock takes what is left: the date
  // and time together, or the time alone, or nothing. The tail still outranks
  // both - it is the thing the bar was widened to report.
  for (const clock of [`${date} ${time}`, time, '']) {
    const clockPx = clock ? textWidth(clock) + SPACE_W : 0
    if (textWidth(title + tail) + clockPx > HEADER_WIDTH && clock) continue
    return layOut(title, tail, clock)
  }
  return layOut(title, tail, '')
}

/** One bar's worth: the head, its tail, and a right-parked clock that may be
 *  empty. The head is what yields if the three do not fit. */
function layOut(title: string, tail: string, clock: string): string {
  const clockPx = clock ? textWidth(clock) : 0
  const gap = clock ? SPACE_W : 0
  const build = (h: string, spaces: number) => `${h}${tail}${' '.repeat(spaces)}${clock}`
  let head = title
  while (head && textWidth(head + tail) + gap + clockPx > HEADER_WIDTH) head = head.slice(0, -1)
  let spaces = clock
    ? Math.max(1, Math.floor((HEADER_WIDTH - textWidth(head + tail) - clockPx) / SPACE_W))
    : 0
  // Kerning across the join can cost a pixel or two; give it back rather than
  // hand the container a line it has to wrap.
  let out = build(head, spaces)
  while (spaces > 1 && textWidth(out) > HEADER_WIDTH) {
    spaces--
    out = build(head, spaces)
  }
  // One space is the floor, and measuring the parts separately can still land
  // a pixel or two over once they are joined. Past that the title yields -
  // never the tail, which is the thing the bar was widened to report. Without
  // this the bar overflowed for roughly a fifth of the day, depending on which
  // digits the clock happened to be showing.
  while (head && textWidth(out) > HEADER_WIDTH) {
    head = head.slice(0, -1)
    out = build(head, spaces)
  }
  return out
}

function isWaiting(s: Session): boolean {
  return s.indicatorState === 'waiting_input' || (!!s.waitingToolName && s.waitingToolName !== 'UserInput')
}

/**
 * The one thing a list row has room to say about state.
 *
 * Waiting used to get `[!]`, and on a real machine seven of eight rows carried
 * it — a mark almost everything has stopped distinguishing anything. Waiting
 * is the resting state of an agent; running is the news. So the badge is the
 * spinner and nothing else, and the rest of the answer is one tap away.
 *
 * The blank is a full-width space, not an ordinary one: at 320 units it is
 * exactly a spinner frame wide, and 5-unit spaces would leave every unmarked
 * name starting three-quarters of a column to the left of the marked ones.
 */
const BADGE_BLANK = '\u3000'

/**
 * The mark on a session that wants the wearer.
 *
 * Full width, like the spinner and the blank, so the names beside it stay in
 * one column. The same glyph a relay item already used: to the reader the two
 * mean one thing - this one is asking - and which mechanism noticed is not
 * something to spend a second symbol on.
 */
const WAITING_BADGE = '！'

/**
 * The cursor column, and what stands in it on the other rows.
 *
 * Two spaces, not one. `>` is 10px on this panel and a space is 5, so a single
 * space left the row under the cursor sitting 5px right of every other row -
 * and since the cursor moves on every swipe, the whole list appeared to shiver
 * sideways as it was walked. Measured, not counted: two spaces come to exactly
 * the 10px the marker takes.
 */
const CURSOR_HERE = '>'
const CURSOR_NONE = '  '

/**
 * Pad a badge out to the width of the column it sits in.
 *
 * The badges no longer agree on a width: `！` is 320 units and the blank beside
 * it the same, but the working dots are 80 and 144 — the whole reason to use
 * them. Left as they are, every running row's name starts a third of a column
 * left of every other one, and the list ripples sideways as rows change state.
 *
 * Ordinary spaces are 5 units, so the pad lands within one of the column rather
 * than on it. Measured in a loop instead of divided out: `textWidth` charges
 * for the kerning across each join, and this is the column everything else on
 * the row is positioned from.
 */
const BADGE_W = textWidth(BADGE_BLANK)

function padBadge(badge: string): string {
  let out = badge
  while (textWidth(`${out} `) <= BADGE_W) out += ' '
  return out
}

/**
 * What a workspace's row says about its state.
 *
 * Only `processing` used to be marked, so `waiting_input` - the state most
 * worth finding on this screen - looked exactly like idle. That was survivable
 * while the list floated waiting sessions to the top; once the order was frozen
 * so the cursor would hold still, the mark became the only way to find them.
 *
 * Waiting outranks working: a session that is running will finish on its own,
 * and one that is asking will not.
 *
 * Read from the panes first. A heading summarises what is folded under it, and
 * the panes can be below the fold when the heading is the last visible row -
 * which is exactly when the summary is the only thing there is to go on.
 */
function workspaceLabel(s: Session, frame: string): string {
  const panes = s.panes ?? []
  if (s.indicatorState === 'waiting_input') return WAITING_BADGE
  if (panes.some((p) => p.indicatorState === 'waiting_input')) return WAITING_BADGE
  if (s.indicatorState === 'processing') return padBadge(frame)
  if (panes.some((p) => p.indicatorState === 'processing')) return padBadge(frame)
  return BADGE_BLANK
}

/**
 * What tells a workspace from a pane inside it.
 *
 * The brackets are on *every* workspace, not only the ones that have panes
 * showing. That is what makes the rule worth having: bracketed is a workspace,
 * bare and indented is a pane of the one above. Bracketing only the expanded
 * ones would leave a single-pane workspace looking exactly like a pane, which
 * is the confusion this is here to remove.
 *
 * It replaces a box-drawing tree (`├` / `└`). The tree said which pane was
 * last, which nobody was asking; what was being asked was which name owned
 * which, and an indent under a bracketed name says that with less ink.
 */
const WS_OPEN = '['
const WS_CLOSE = ']'
/**
 * What sits where the workspace's `[` does, plus two spaces.
 *
 * Measured rather than counted: the opening bracket is 8px against a 5px
 * space, so the three spaces this started as put the pane name 2px right of
 * the workspace name above it - an indent nobody could see. Five spaces is
 * 25px against the name's 13px, the nearest the space width can get to the two
 * clear spaces asked for.
 */
const PANE_INDENT = '     '

/** The rule between a question's text and its choices, inside the card. Cut to
 *  the card's width rather than the panel's, or it runs under the border. */
const CARD_SEPARATOR = '-'.repeat(Math.floor(CARD_WIDTH / textWidth('-')))

/**
 * The working indicator, one frame per tick.
 *
 * A static mark says the session was working when the screen was last drawn; a
 * moving one says it is working now, which is the question being asked. The
 * frames are all 320 units wide — an uneven set shifts everything after it on
 * each turn and reads as a shiver rather than a beat, which is what ruled out
 * the ASCII `|/-\` and the Braille spinner the CLI world uses (the firmware has
 * no glyphs for the latter at all).
 *
 * Two frames, not a rotation. At one frame per three seconds nobody sees a
 * turning triangle — they see whichever of `▲▶▼◀` happened to be up when they
 * looked, which is a different symbol each time and reads as four states rather
 * than one. A dot that grows and shrinks reads as one thing, beating, however
 * rarely it is sampled.
 *
 * These two are the only small glyphs the firmware carries that pair: `·` at 80
 * units and `•` at 144, against the 320 of every full-width mark. Everything
 * else this size is a punctuation mark on the baseline (`′ ″ ‘ ’`) or sits
 * raised off it (`° º ⁰`), which beats vertically as well as in size. Being
 * narrow is the point — a status mark should be the quietest thing on a row it
 * shares with a name, and `●` was a bullet hole in the middle of one.
 */
const SPINNER = ['·', '•']


/** Slow on purpose: each frame costs a BLE round trip, and the question is
 *  only whether something is alive. */
export const SPINNER_INTERVAL_MS = 3000

/**
 * How long a recording runs before stopping itself.
 *
 * Spoken instructions to an agent are short - a sentence, two at most - so an
 * open microphone is far more likely to be one somebody forgot to stop than
 * one still being spoken into. Left running it costs the wearer's battery, the
 * upload, and Groq quota, and produces a transcript with a minute of room
 * noise on the end.
 *
 * The screen says the number rather than counting down to it. A countdown
 * would mean redrawing the panel every second over BLE for the entire
 * recording, which is the opposite of how everything else here behaves: the
 * spinner is deliberately slow for the same reason, and an idle app sends
 * nothing at all.
 */
export const MAX_RECORDING_MS = 30_000

function spinnerFrame(state: AppState): string {
  return SPINNER[(state.spinnerTick ?? 0) % SPINNER.length]
}

/**
 * The recap block, capped in *display* lines.
 *
 * `recapBlockLines` counts logical lines, so a recap that arrives as one long
 * sentence — the usual shape — passed the cap untouched and then wrapped to
 * five or six rows, crowding out the conversation it was meant to introduce.
 */
function recapBlock(recap: string | undefined, maxLines = 2): string[] {
  // Every line, not the first two: the strip shows `NOTICE_MAX_LINES` of them
  // at a time and the clock walks the rest. Cutting here would throw away what
  // the walking is for.
  //
  // Unwrapped, too. The strip scrolls by character and re-wraps what is left,
  // so wrapping here would freeze the line breaks at the offsets they had on
  // the first step and the text would reflow against a stale grid.
  return recapBlockLines(recap, maxLines)
}

/** Display label for a relay item's session (live session name, else the id). */
function relayLabel(state: AppState, item: GlassesRelayItem): string {
  const s = state.sessions.find((x) => x.id === item.sessionId)
  return s ? sName(s) : item.sessionId
}

/** What the strip says over an answer just sent. English, like everything the
 *  panel draws itself. */
export const SENT_LABEL = 'Sent'

/** How long the answer stays on the strip before the queue has it back. Long
 *  enough to read at a glance, short enough that it is gone before the next
 *  question of a multi-step ask arrives. */
export const ANSWER_ECHO_MS = 2500

/** Waiting/info banner prepended to the TOP of the conversation tab.
 *  Waiting-first is the core philosophy: the highest-priority waiting item
 *  always heads the view; an info item shows only when nothing is waiting. */
function relayBannerLines(state: AppState): string[] {
  // Ahead of the queue on purpose: for these few seconds the answer is the
  // news, and the question it answered is not - it is still on the strip only
  // because the server has not seen the pane move yet.
  if (state.answered && Date.now() < state.answered.until) {
    return [`[>] ${SENT_LABEL}`, state.answered.text]
  }
  const top = state.relayWaiting[0]
  if (top) {
    const choiceHint = top.choices?.length ? `(${top.choices.length} choices)` : ''
    const more = state.relayWaiting.length > 1 ? ` +${state.relayWaiting.length - 1} more` : ''
    const head = splitDisplayLines(`[!]${relayLabel(state, top)}${choiceHint}${more}`)[0] || ''
    // All of it, unwrapped; the strip windows what fits and the clock walks the
    // rest, re-wrapping at every step. Only the head is clamped — it is a
    // label, and a label that takes two lines is not one.
    return [head, top.text]
  }
  // Notifications get no body space here. The dialog already presented each
  // one full-screen, and the list keeps them in full afterwards; a third
  // showing spends two of seven lines — text plus separator — of the very
  // conversation the reader chose to open. The header carries a count instead,
  // which is the part that is still news while reading.
  //
  // Questions stay: one carries the choices needed to answer it, which is not
  // something the transcript below shows.
  return []
}

/** Notifications waiting that are NOT about the session being read. */
export function otherSessionInfoCount(state: AppState): number {
  const openId = state.sessions[state.sessionIndex]?.id
  return state.relayInfo.filter((i) => i.sessionId !== openId).length
}

// ─── Content helpers (shared by build and in-place update) ───


/** One line of the list: a workspace, a pane inside one, or a group label. */
export interface ListRow {
  sessionIndex: number
  /** Absent on the workspace's own row. */
  paneId?: string
  /**
   * A label, not a target.
   *
   * A multi-pane workspace's own row has nothing to open: it would fall back
   * to the representative agent the server picked, which is one of the panes
   * chosen arbitrarily — exactly the ambiguity the pane rows exist to remove.
   * So the name becomes a heading over them and the cursor passes it by.
   */
  header?: boolean
  /**
   * The way in to the relay items.
   *
   * The overlay has always been a browsable list of every waiting question and
   * every notification, with a counter and `swipe:next` to walk it — but nothing
   * could open it deliberately. It appeared when a question arrived and that was
   * the only way in, so a wearer who dismissed it, or who wanted to reread an
   * older notice, had no route back. The list said `+2` and offered no way to
   * reach the two.
   *
   * This is that route: the line the notices were already being printed on,
   * turned into somewhere the cursor can rest.
   */
  notifications?: true
}

/**
 * The list, flattened for navigation.
 *
 * A workspace with one pane is not expanded. `%1` under a name it already
 * carries is a level of hierarchy that says nothing, and lines are the
 * scarcest thing on this screen. Two or more panes are separate agent
 * conversations with separate session ids, and only then does the workspace
 * row stop being the whole story.
 */
export function listRows(sessions: Session[], withNotifications = false): ListRow[] {
  const rows: ListRow[] = []
  // First, and pinned there by `sessionListBody` — a notice that scrolled out of
  // sight would be worse than the banner it replaces. `sessionIndex` is -1
  // because there is no session behind it; every reader of a row checks
  // `notifications` before touching it.
  if (withNotifications) rows.push({ sessionIndex: -1, notifications: true })
  sessions.forEach((s, sessionIndex) => {
    const panes = s.panes ?? []
    if (panes.length < 2) {
      rows.push({ sessionIndex })
      return
    }
    rows.push({ sessionIndex, header: true })
    for (const p of panes) rows.push({ sessionIndex, paneId: p.paneId })
  })
  return rows
}

/** Rows the cursor can rest on. */
export function selectableRows(sessions: Session[], withNotifications = false): ListRow[] {
  return listRows(sessions, withNotifications).filter((r) => !r.header)
}

/** Whether the list is showing a way in to the relay items — one line, and only
 *  when there is something behind it. Seven lines is not enough to keep an empty
 *  row for later. */
export function hasNotificationRow(state: AppState): boolean {
  return state.relayWaiting.length + state.relayInfo.length > 0
}

/** Index of the row the cursor is on. */
export function rowCursor(state: AppState): number {
  const withNotifications = hasNotificationRow(state)
  const rows = listRows(state.sessions, withNotifications)
  // A stale flag — the notices cleared while the cursor sat on them — falls
  // through to the session lookup below rather than pointing at a row that is
  // no longer there.
  if (state.listOnNotifications && withNotifications) return 0
  const found = rows.findIndex(
    (r) =>
      !r.header && !r.notifications &&
      r.sessionIndex === state.sessionIndex && r.paneId === state.selectedPaneId,
  )
  if (found >= 0) return found
  // Landed on a workspace that turned out to have panes — a fresh state, or a
  // pane count that grew underneath. Its first pane is what the row meant.
  const fallback = rows.findIndex((r) => !r.header && r.sessionIndex === state.sessionIndex)
  return fallback >= 0 ? fallback : 0
}

/** The same for one pane. Waiting outranks working, for the same reason. */
function paneStatusLabel(p: Pane, frame: string): string {
  if (p.indicatorState === 'waiting_input') return WAITING_BADGE
  if (p.indicatorState === 'processing') return padBadge(frame)
  return BADGE_BLANK
}

/**
 * What tells two panes of one workspace apart.
 *
 * Not the command: every pane here runs `claude`, so printing it fills a line
 * with a constant. Not the directory either, unless the panes actually differ
 * in it — two panes of one repo repeat the same folder name and the reader
 * learns nothing from the second one. What is left is the context figure,
 * which does differ, and says which of the two has been running longer.
 */
/**
 * What to call a pane.
 *
 * `%3` is an address, not a name: it says where the pane sits in the split
 * tree and nothing about what is running there. herdr lets the user name one
 * (`herdr pane rename`), and once they have, the name is the whole reason they
 * bothered. The id stays as the fallback, because most panes are never named
 * and an empty label would leave the row pointing at nothing.
 */
function paneName(p: Pane | undefined, paneId: string): string {
  const label = p?.label?.trim()
  return label || paneId
}

/**
 * Context use as one glyph.
 *
 * The eight block heights are the only ordered run of glyphs the firmware
 * carries that is also one width throughout - `▁` measures the same 320 units
 * as `█`, so a column of them is a bar chart and not a ragged edge. `░` and `▓`
 * would have given a shading ramp instead, and the panel has neither.
 *
 * It fills as the context does, matching the web UI's bar: a row that is nearly
 * out of runway is the tall one, which is the one worth finding. Eight steps is
 * coarser than the figure beside it and that is the point - the glyph answers
 * "how full", the number answers "how full exactly".
 */
const CTX_BLOCKS = '▁▂▃▄▅▆▇█'

function ctxGlyph(pct: number): string {
  const step = Math.ceil((pct / 100) * CTX_BLOCKS.length) - 1
  return CTX_BLOCKS[Math.min(CTX_BLOCKS.length - 1, Math.max(0, step))]
}

/**
 * Which model is running, short enough for a list row.
 *
 * `claude-opus-5-20260101` is thirty characters of which two matter: on a
 * screen where every workspace runs `claude`, the family and its version are
 * the whole difference between them. Anything not Claude's is left as the
 * provider wrote it, minus the vendor prefix Kimi and the OpenRouter models
 * carry (`moonshotai/kimi-k3`) - that names who sells it, not what is running.
 */
function modelShort(model: string | undefined): string {
  if (!model) return ''
  const bare = model.split('/').pop() ?? model
  if (!bare.startsWith('claude-')) return bare
  const tokens = bare
    .slice('claude-'.length)
    .split('-')
    .filter((tok) => !/^\d{8}$/.test(tok))
  const family = tokens.find((tok) => /^[a-z]/i.test(tok))
  if (!family) return bare
  const version = tokens.filter((tok) => /^\d+$/.test(tok)).join('.')
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return version ? `${name} ${version}` : name
}

/**
 * What every row carries: how full, and nothing else.
 *
 * The figure and the model went to the footer. Thirteen rows each ending in
 * `Opus 5 42%` is the same two facts printed thirteen times — the model is
 * usually the same one throughout, and the exact percent is a number nobody
 * compares digit by digit while walking a list. The glyph is what survives that
 * cut: a column of block heights answers "which of these is filling up" at a
 * glance, which is the only question the list itself is asked.
 */
function ctxMark(m: RowMetrics | undefined): string {
  const pct = m?.contextPercent
  return pct != null ? ctxGlyph(pct) : ''
}

/** The figures behind the glyph, for the one row the cursor is on. */
function metricsDetail(m: RowMetrics | undefined): string {
  const pct = m?.contextPercent
  return [modelShort(m?.model), pct != null ? `${Math.round(pct)}%` : ''].filter(Boolean).join(' ')
}

/**
 * The directory, on the panes that do not share one.
 *
 * Two panes of one repo repeat the same folder name and the reader learns
 * nothing from the second, so it is shown only where it tells them apart.
 *
 * Which tab a pane sits in is not shown at all. It was, while a reply to one in
 * another tab could not land — a mark for "readable but unanswerable". The
 * server switches tabs to deliver now, so the pane behaves like any other and
 * the label would be a fact with no decision attached to it.
 */
function paneDetail(p: Pane, siblings: Pane[]): string {
  const dirOf = (x: Pane) => x.currentPath?.split('/').filter(Boolean).pop() ?? ''
  const dirs = new Set(siblings.map(dirOf))
  return dirs.size > 1 ? dirOf(p) : ''
}

/**
 * A row's context mark, labelled and set beside the name it belongs to.
 *
 * Parked at the right edge it made a tidy column and read as a separate thing —
 * a bar chart running down the panel that the eye had to travel to and then
 * travel back from to see whose it was. Against the name it is one phrase:
 * this workspace, this full. The label is what makes a lone block legible;
 * `ctx:` follows the `tap:open` / `swipe:nav` shorthand the footer already uses.
 *
 * The name yields when the two will not fit — a name clipped to `…` still names
 * its row, where a mark pushed off the edge says nothing about having gone.
 * Overflow is never an option: the list wraps at `BODY_WIDTH`, so a row one
 * pixel over costs a second of the seven lines.
 */
function withCtx(left: string, mark: string): string {
  if (!mark) return left
  const tail = ` ctx:${mark}`
  const room = BODY_WIDTH - textWidth(tail)
  const head = textWidth(left) > room ? ellipsize(left, room) : left
  return `${head}${tail}`
}

/**
 * The newest info item, as one banner line above the list.
 *
 * The list is where the glasses rest when nothing is happening — which is
 * exactly when a notification arrives. Without this it would surface only on
 * the conversation tab, i.e. only to a reader already looking at the session it
 * came from, who is the one person who did not need telling.
 *
 * Waiting items are deliberately absent: they raise the overlay and mark their
 * own row with ！, so repeating them here would spend the scarcest line on the
 * screen saying something the screen already says.
 */
/**
 * The notifications row's text: what the banner used to say, on a line the
 * cursor can now reach.
 *
 * A waiting question comes first when there is one. It is the item that wants
 * something from the reader, and `[!]` against `[i]` is the difference between
 * "answer me" and "for your information" — which is worth more than showing
 * whichever arrived last.
 *
 * The count sits next to the label rather than after the text, because the text
 * is what gets cut at the panel edge and `+2` is the part that has to survive.
 */
function notificationRowText(state: AppState, marker: string): string {
  const total = state.relayWaiting.length + state.relayInfo.length
  const item = state.relayWaiting[0] ?? state.relayInfo[0]
  if (!item) return ''
  const badge = item.kind === 'waiting' ? '[!]' : '[i]'
  const more = total > 1 ? `+${total - 1}` : ''
  // The cursor column is part of the line and has to be part of the measurement.
  // Wrapping the text alone produced a first line that filled the panel exactly,
  // and prepending the marker afterwards pushed one character onto a second
  // line — a notice occupying two rows, which is the thing this row exists to
  // avoid. Found by looking at the panel; the arithmetic looked fine.
  const wrapped = splitDisplayLines(`${marker}${badge}${relayLabel(state, item)}${more}: ${item.text}`)
  const line = wrapped[0] || ''
  if (!line) return ''
  // A message cut at the panel edge with nothing to show for it reads as a
  // complete, and wrong, sentence. Opening the row shows the rest.
  return wrapped.length > 1 ? ellipsize(line) : line
}

/**
 * The pinned notification, as its own strip above the list.
 *
 * Split out of the list body so it can be drawn in a bordered container rather
 * than as one more row of text. Sharing the list's background is how it kept
 * being read as another session: the eye walks a column of names and a notice
 * sitting in that column is a name. A box around it is not.
 *
 * Empty when there is nothing waiting, which is also what tells the renderers
 * there is no strip to leave room for.
 */
function sessionListNotice(state: AppState): string {
  if (!hasNotificationRow(state)) return ''
  return notificationRowText(state, rowCursor(state) === 0 ? CURSOR_HERE : CURSOR_NONE)
}

function sessionListBody(state: AppState): string {
  const { sessions } = state
  // Relay waiting covers agent-declared items whose session indicator is not
  // waiting_input; those sessions still get the [!] marker.
  const relayWaitingIds = new Set(state.relayWaiting.map((i) => i.sessionId))
  const frame = spinnerFrame(state)
  const cursor = rowCursor(state)
  // Pinned rather than scrolled with the rest. It replaces a banner that was
  // always on screen, and a notice that slid out of view as the reader walked
  // down thirteen workspaces would be a worse thing than the banner was.
  // The strip itself is drawn by `sessionListNotice` into a container of its
  // own; what is counted here is the row it costs the list.
  const pinned = hasNotificationRow(state) ? 1 : 0
  const rows = listRows(sessions, pinned === 1)
  const scrollable = rows.slice(pinned)
  if (!scrollable.length) return '(no sessions)'
  const listLines = LIST_LINES - pinned
  // The cursor's index within the scrolling part; the pinned row is index 0 of
  // the whole list and never part of the window.
  const inScroll = Math.max(0, cursor - pinned)
  const start = Math.max(0, Math.min(inScroll - 3, scrollable.length - listLines))
  const visible = scrollable.slice(Math.max(0, start), Math.max(0, start) + listLines)

  const listBody = visible.map((row, i) => {
    const idx = pinned + Math.max(0, start) + i
    const here = idx === cursor ? CURSOR_HERE : CURSOR_NONE
    const s = sessions[row.sessionIndex]
    // Pad the badge so every name starts in the same column: a list where
    // `>[!] name` and `  name` begin three columns apart is hard to scan.
    if (row.header || !row.paneId) {
      // A relay item is a question already asked and still unanswered, which
      // outlives the indicator that raised it; that one keeps its mark.
      // The relay knows about questions herdr has not called `blocked` - an
      // agent's own declared wait. It cannot see the other direction, so the
      // indicator is consulted too rather than instead.
      const label = relayWaitingIds.has(s.id) ? WAITING_BADGE : workspaceLabel(s, frame)
      // A heading takes no cursor, so it never carries the marker.
      const name = `${row.header ? CURSOR_NONE : here}${label} ${WS_OPEN}${sName(s)}${WS_CLOSE}`
      // A heading's panes carry their own mark on the rows underneath it, and
      // one bar covering three agents would be a level describing none of them.
      return row.header ? name : withCtx(name, ctxMark(s.metrics))
    }
    const panes = s.panes ?? []
    const p = panes.find((x) => x.paneId === row.paneId)
    const dir = p ? paneDetail(p, panes) : ''
    const name = `${here}${p ? paneStatusLabel(p, frame) : BADGE_BLANK}${PANE_INDENT}${paneName(p, row.paneId)}`
    return withCtx(`${name}${dir ? ` ${dir}` : ''}`, ctxMark(p?.metrics))
  })

  return listBody.join('\n')
}

/**
 * Whether the recap still has anything to add.
 *
 * It summarises what happened before it was written — the point of it is to
 * fill in a stretch the reader missed. Once a message newer than the recap is
 * on screen the reader is past it, and three of seven lines are better spent
 * on the conversation than on a description of what came before it.
 *
 * Anything unknown means keep showing it: a missing timestamp is not evidence
 * that the recap is stale.
 */
function recapIsCurrent(recapAt: string | undefined, msgs: ConversationMessage[]): boolean {
  const newestAt = msgs[msgs.length - 1]?.timestamp
  if (!recapAt || !newestAt) return true
  const recapTime = Date.parse(recapAt)
  const newestTime = Date.parse(newestAt)
  if (Number.isNaN(recapTime) || Number.isNaN(newestTime)) return true
  return newestTime <= recapTime
}

/**
 * Geometry of the notice strip: how tall it is, and what the conversation has
 * left underneath it.
 *
 * The rule between them is a container border, not a row of text, so it costs
 * `NOTICE_BORDER` pixels instead of a 27px line. Padding is cut to 2 for the
 * same reason — this strip is a label, not a page, and every pixel it does not
 * take is one the conversation does.
 */
export const NOTICE_PAD = 2
export const NOTICE_BORDER = 1
/** 0-15 on this panel's 16 greens. Bright enough to read as a rule, dim enough
 *  that it does not compete with the text it is separating. */
export const NOTICE_BORDER_COLOR = 6
/**
 * Everything the notice strip has to say, before it is windowed — unwrapped.
 *
 * Shared with the auto-advance clock, which has to know how much is waiting
 * behind the strip without rendering it.
 */
/**
 * What kind of recap an agent produces, when the server did not say.
 *
 * `ccRecapKind` is the answer, and the server that sends it is newer than some
 * of the glasses that will ask. An ehpk outlives its server routinely - it is
 * installed from a store, and the server is updated by hand - so the app is
 * left holding the old shape, where a thread agent's copy of its own last
 * message is indistinguishable from Claude's summary and gets a permanent
 * strip either way.
 *
 * Which agent it is, it does know. Every agent but Claude reaches its recap
 * the same way (`AgentThread.recap`: there is no away_summary to read, so the
 * latest assistant message stands in), and that is a property of the agent
 * rather than of the version talking to us.
 *
 * Consulted only when the server said nothing. Where it does say, it wins:
 * this list is a copy of something the other side knows for certain, and a
 * copy that outvoted the original would be worse than no copy at all.
 */
function kindOfAgent(agent: string | undefined): 'summary' | 'last-message' {
  return agent && agent !== 'claude' ? 'last-message' : 'summary'
}

function conversationNoticeText(state: AppState): string {
  const session = state.sessions[state.sessionIndex]
  const pane = state.selectedPaneId
    ? (session?.panes ?? []).find((p) => p.paneId === state.selectedPaneId)
    : undefined
  const banner = relayBannerLines(state)
  // Recap heads the latest view; deeper paging drops it for message space,
  // and so does the conversation moving past it.
  const onLatest = state.conversationOffset === 0 && state.conversationPage === 0
  const recapText = pane ? pane.recap : session?.ccRecap
  const recapAt = pane ? pane.recapAt : session?.ccRecapAt
  // A pane's recap is Claude's, so it is always a summary. A session's may be
  // a thread agent's copy of its own latest message, and that one is not shown:
  // it repeats the message directly beneath it and takes two of eight lines to
  // do it. Kimi's was up on 79% of its conversation frames on 2026-08-08,
  // against 0% for Claude on the same day - the difference is not that Kimi
  // talks more, it is that the staleness test cannot retire a recap whose
  // source *is* the newest message. Nothing retires it, so it never leaves.
  const isSummary = pane ? true : (session?.ccRecapKind ?? kindOfAgent(session?.agent)) === 'summary'
  const recap = onLatest && isSummary && recapIsCurrent(recapAt, state.conversation)
    ? recapBlock(recapText)
    : []
  return [...banner, ...recap].join('\n')
}

/** A notice longer than the conversation it introduces has stopped helping —
 *  so a long one is shown this many lines at a time instead of all at once. */
const NOTICE_MAX_LINES = 2

/**
 * Characters the strip gives up from its front on each step.
 *
 * The unit of the scroll is the character, not the line: a line at a time
 * moved the text in 27px jumps and read as three separate screens rather than
 * one moving one. Taking a few characters off the front and re-wrapping what
 * is left slides the whole block instead, which is what it looks like to read
 * along a line rather than be shown another one.
 *
 * Ten and not one: every step is a redraw over BLE, and one character per
 * redraw would spend a hundred and fifty of them on a recap. Ten is about a
 * third of a Japanese line — coarse enough to keep the redraws near what line
 * scrolling cost, fine enough that the block still reads as sliding rather
 * than being replaced.
 *
 * Paired with `AUTO_SCROLL_STEP_MS`: the two move together, so changing this
 * without changing that changes the reading speed as well as the granularity.
 */
export const NOTICE_SCROLL_CHARS = 10

/**
 * What is left of the notice once `from` characters have gone past.
 *
 * Leading whitespace goes with them: a step can land on a line break or on the
 * space a wrap fell on, and a strip that starts with a blank row reads as the
 * notice having ended rather than having moved.
 */
function noticeFrom(chars: string[], from: number): string {
  return chars.slice(from).join('').replace(/^\s+/, '')
}

/** True once everything left of `from` fits the strip — i.e. the last
 *  character of the notice is on screen. */
function noticeFitsFrom(chars: string[], from: number): boolean {
  return splitDisplayLines(noticeFrom(chars, from)).length <= NOTICE_MAX_LINES
}

/**
 * Every offset the strip stops at, from the notice's first character to its
 * last.
 *
 * Walked rather than multiplied out. A step is capped at what the reader can
 * actually see, so it can never advance past the bottom of the strip: a notice
 * of short lines — a banner over a bulleted recap, say — shows barely more
 * than a step's worth at a time, and a fixed stride would carry lines off the
 * top that were never on screen. Silently skipping part of the recap is the
 * failure this scrolling exists to fix.
 *
 * Prose steps the full `NOTICE_SCROLL_CHARS` every time, which is the case
 * this runs in almost always; the cap only bites on the shapes that need it.
 */
function noticeStops(text: string): number[] {
  const chars = Array.from(text)
  const stops = [0]
  let from = 0
  while (!noticeFitsFrom(chars, from)) {
    const shown = splitDisplayLines(noticeFrom(chars, from)).slice(0, NOTICE_MAX_LINES).join('').length
    // At least one character, so a strip that somehow shows nothing still
    // terminates rather than walking the same offset forever.
    from += Math.max(1, Math.min(NOTICE_SCROLL_CHARS, shown))
    stops.push(from)
  }
  return stops
}

/** How many steps the strip takes to walk a notice from end to end. */
function noticeScrollStepsOf(text: string): number {
  return noticeStops(text).length
}

/**
 * The notice with `window` steps' worth of characters taken off its front.
 *
 * Held at the last step rather than wrapped around: the clock decides when to
 * go back to the beginning, and it waits at the end first so the last line is
 * read rather than glimpsed.
 */
function noticeScrollOf(text: string, window: number): string[] {
  if (!text) return []
  const stops = noticeStops(text)
  const from = stops[Math.max(0, Math.min(window, stops.length - 1))]
  return splitDisplayLines(noticeFrom(Array.from(text), from)).slice(0, NOTICE_MAX_LINES)
}

/**
 * How many steps the notice takes to scroll through in full.
 *
 * The auto-advance clock asks this to know whether waiting will reveal
 * anything more, so it can move on to the conversation instead of sitting on
 * a strip that has already shown everything it has.
 */
export function noticeScrollSteps(state: AppState): number {
  if (state.mode !== 'conversation') return 1
  return noticeScrollStepsOf(conversationNoticeText(state))
}

export function noticeHeight(lines: number): number {
  return lines > 0 ? lines * LINE_H + 2 * NOTICE_PAD + 2 * NOTICE_BORDER : 0
}

/** Display lines the conversation keeps once the notice has taken its share. */
export function conversationLines(noticeLines: number): number {
  const body = PANEL_H - 2 * BAR_H - noticeHeight(noticeLines)
  return Math.max(0, Math.floor((body - 2 * BODY_PAD) / LINE_H))
}

/**
 * The lines the conversation body has right now, notice included.
 *
 * The single answer to "how much fits", so that what is paged and what is
 * drawn cannot disagree. The controller needs it too: it counts pages to know
 * when a swipe should move to the next message instead of the next page.
 */
export function conversationBodyLines(state: AppState): number {
  const notice = noticeScrollOf(conversationNoticeText(state), state.noticeWindow ?? 0)
  return conversationLines(notice.length)
}

function conversationContent(state: AppState): {
  headerText: string
  noticeText: string
  bodyText: string
  footerText: string
} {
  const session = state.sessions[state.sessionIndex]
  // Reading one pane of a workspace, its status is the one that applies — the
  // workspace's is a summary of panes the reader is not looking at.
  const pane = state.selectedPaneId
    ? (session?.panes ?? []).find((p) => p.paneId === state.selectedPaneId)
    : undefined
  const waiting = pane
    ? pane.indicatorState === 'waiting_input' || (!!pane.waitingToolName && pane.waitingToolName !== 'UserInput')
    : session ? isWaiting(session) : false
  const ind = pane ? pane.indicatorState : session?.indicatorState
  const statusBadge = waiting ? '  [!] WAITING' : ind === 'processing' ? `  ${spinnerFrame(state)}` : ''
  const demoTail = state.demo ? DEMO_TAIL : ''

  const msgs = state.conversation
  const msgIndex = msgs.length > 0
    ? Math.max(0, msgs.length - 1 - state.conversationOffset)
    : -1
  // The notice is measured first, because what it leaves is what the
  // conversation may both draw *and* page by. Paging by the panel's full
  // height while drawing less put whole lines on no page at all.
  const allNotice = conversationNoticeText(state)
  // The notice block gets its own container so the panel can draw the line
  // between them as a border. It used to be a row of dashes inside this one,
  // which spent 27px — a seventh of everything the reader gets — on a rule.
  const noticeLines = noticeScrollOf(allNotice, state.noticeWindow ?? 0)
  const noticeText = noticeLines.join('\n')
  const bodyLines = conversationLines(noticeLines.length)
  const { text: convText, pageInfo } = paginateMessage(msgs, msgIndex, state.conversationPage, bodyLines)
  // The body container clips overflow: cap the banner+recap+content block at
  // one page so a waiting overlay never pushes conversation text off-screen.
  // Everything is measured in display lines — counting the conversation in
  // logical lines let a wrapped paragraph run off the bottom unnoticed.
  const content = convText.split('\n').flatMap(splitDisplayLines)
  // The body container clips overflow, so this is a backstop rather than the
  // decision: the page was built to `bodyLines` above, and anything past it
  // here would be a line the next page does not begin with.
  const bodyText = content.slice(0, bodyLines).join('\n')
  // With a waiting banner up, the ring is routed to the overlay item:
  // tap = respond/jump, double-tap = dismiss ("later / on PC").
  // Read some way back, the double-tap returns to the newest message rather
  // than leaving the session, so the label has to say which one it will do.
  const scrolled = state.conversationOffset > 0 || state.conversationPage > 0
  const back = scrolled ? 'dbl:top' : 'dbl:back'
  const action = state.relayWaiting.length > 0
    ? 'tap:respond  dbl:later'
    : waiting ? `tap:respond  ${back}` : back
  // Who is speaking is in the body — the user's turn carries `$` and the
  // agent's carries nothing — so repeating it here said nothing twice. The
  // message counter went with it: its denominator was the number of messages
  // loaded so far, not the length of the conversation, so the same position
  // showed a different fraction after paging back and nobody could read it as
  // anything. Only the page number is left, which does mean what it says.

  // The count, not the text: enough to know something landed and that the list
  // is worth a look, without spending the lines to say what.
  const notices = otherSessionInfoCount(state)
  const noticeMark = notices > 0 ? `  [i]${notices}` : ''
  return {
    noticeText,
    headerText: withClock(
      `${session ? sName(session) : '---'}${pane ? ` ${paneName(pane, pane.paneId)}` : ''}`,
      `${statusBadge}${noticeMark}${demoTail}`,
    ),
    bodyText,
    footerText: pageInfo ? `${action}  ${pageInfo.trim()}` : action,
  }
}

// Footers that are fixed per mode (the rest are built with their content).
// Named so the browser simulator renders the same string the G2 does instead
// of a hand-copied approximation.
/**
 * The metrics of whatever the cursor is on — a workspace's own, or a pane's.
 *
 * The notification row stands for no session at all, so it reports nothing
 * rather than the metrics of session zero.
 */
function cursorMetrics(state: AppState, row: ListRow | undefined): RowMetrics | undefined {
  if (!row || row.notifications) return undefined
  const s = state.sessions[row.sessionIndex]
  if (!s) return undefined
  if (!row.paneId) return s.metrics
  return (s.panes ?? []).find((p) => p.paneId === row.paneId)?.metrics
}

/** Everything the list screen has to say, in the one bar it still has. */
function sessionListFooter(state: AppState): string {
  // Counted among what can be opened; headings are not places to be.
  const rows = listRows(state.sessions, hasNotificationRow(state))
  const at = rows[rowCursor(state)]
  const selectable = rows.filter((r) => !r.header)
  const cursor = selectable.findIndex((r) => r === at) + 1
  const total = selectable.length
  const badge = state.relayWaiting.length > 0 ? `  !${state.relayWaiting.length}` : ''
  // The gesture does something different on that row, so it says so. A footer
  // that promises `tap:open` and then shows a notice queue has misled the reader
  // about the only control they have.
  const open = at?.notifications ? 'tap:notices' : 'tap:open'
  // Which model, and how full, for the one row being pointed at. It rides as
  // the tail so it outlives the gesture hints when the bar runs short: the
  // hints say what every row does and can be learned once, where this changes
  // with every swipe and is the reason to swipe at all.
  const detail = metricsDetail(cursorMetrics(state, at))
  const demoTail = state.demo ? DEMO_TAIL : ''
  return withClock(`${open}  swipe:nav  ${cursor}/${total}${badge}`, `${detail ? `  ${detail}` : ''}${demoTail}`)
}
const FOOTER_CHOICE = 'swipe:select  tap:confirm  dbl:skip'
/** Double-tap means "leave" on every screen, so a multi-select's third verb
 *  is a row rather than a gesture. */
function footerChoice(state: AppState): string {
  if (!state.choiceMulti) return FOOTER_CHOICE
  // `tap` does one of two things depending on the row, and the row says which.
  // The footer promises the gesture that never changes.
  return `swipe:move  tap:check/send  dbl:cancel`
}

/**
 * A checkbox the pane has already ticked.
 *
 * The brackets survive the scrape, so the state is readable without asking -
 * but the mark inside them is whatever the agent felt like drawing. Claude Code
 * uses U+2714 HEAVY CHECK MARK and kimi uses U+2713 CHECK MARK, and only the
 * lighter one was listed here: every box claude ticked read back as empty, so
 * the send row counted nothing and the panel showed a wearer's own ticks going
 * nowhere. Measured on a live pane on 2026-08-06.
 */
export function isChecked(option: string): boolean {
  return /^\s*\[[xX*\u2713\u2714]\]/.test(option)
}

/** The mark written when this app ticks a box itself. */
export const CHECK_MARK = '\u2714'

/** Whether a scraped option set is a multi-select. One checkbox is enough:
 *  a single-pick list has none at all. */
export function looksMultiSelect(options: string[]): boolean {
  return options.some((o) => /^\s*\[[ xX*\u2713\u2714]\]/.test(o))
}

/** Reply target shown in the choice header — the session the Enter actually
 *  goes to, which differs from the selected one when answering a relay item
 *  for another session. */
function choiceHeader(state: AppState): string {
  const session = state.sessions[state.sessionIndex]
  const name = state.choiceSessionName || (session ? sName(session) : '---')
  return withClock(`${name}  [SELECT]`, state.demo ? DEMO_TAIL : '')
}

/**
 * Wrap text the way the G2's own container would.
 *
 * The device wraps by itself at the panel edge, so several code paths hand it
 * unwrapped text on purpose — `paginateSingleMessage` returns the original
 * string whenever it already fits in seven lines. A simulator drawing with
 * `white-space: pre` has no such container and would let those lines run past
 * the edge, so it wraps them here, through the same width rules the device
 * measures with.
 */
export function wrapForPanel(text: string): string {
  return text.split('\n').flatMap(splitDisplayLines).join('\n')
}

/** Re-wrap a header string the way the header container would. */
export function wrapHeader(text: string): string {
  return splitLines(text, HEADER_WIDTH).join('\n')
}

/**
 * The three container strings the G2 is about to render, for one mode.
 *
 * This is the seam the browser simulator renders through, so what it shows is
 * the device's own output — same wrapping at 52 columns, same 7-line clamp,
 * same pagination — rather than a second implementation that silently drifts.
 */
/**
 * The last thing a run draws before it closes itself.
 *
 * English, like everything the G2 draws — `i18n.ts` covers the phone screens,
 * where the width of a full-width character does not have to be reckoned
 * against `metrics.ts` and the seven-line clamp.
 *
 * Headerless and footerless: there is nothing left to navigate to, and a footer
 * offering gestures that no longer do anything would be worse than none.
 */
function fatalScreen(reason: NonNullable<AppState['fatal']>): {
  header: string
  body: string
  footer: string
  headerless: boolean
} {
  const minutes = Math.round(GIVE_UP_AFTER_MS / 60_000)
  const body =
    reason === 'offline'
      ? [
          // No blanks between the lines: an empty string does not survive the
          // render, so spacing written that way is spacing that only exists
          // in this file. Checked on the simulator.
          //
          // It says what to do, not only what went wrong. Someone meeting
          // this screen is usually meeting the app for the first time - the
          // address is wrong, or the machine is off - and a report of a
          // failure they cannot act on reads as the app being broken. Same
          // reason the unconfigured screen (`buildSetupGuide`) lists steps.
          'Cannot reach the server.',
          `Tried for ${minutes} minutes.`,
          `Start ${__PRODUCT_NAME__} on the machine`,
          'it runs on, and check the address',
          'in the phone app.',
          'Closing to free the glasses.',
        ].join('\n')
      : 'Closing.'
  return { header: '', body, footer: '', headerless: true }
}

export function screenText(state: AppState): {
  header: string
  body: string
  footer: string
  /** Recap / waiting banner, in its own strip above the conversation with a
   *  drawn rule between. Empty when there is nothing to say. Separate from
   *  `body` because the rule is a container border on the device, so anything
   *  redrawing these strings has to put a line there too or it shows a panel
   *  the wearer is not looking at. */
  notice?: string
  /** The list screen drops its header container, so its body starts at the top
   *  of the panel rather than below a bar. Anything drawing these strings has
   *  to know, or it renders a row lower than the device does. */
  headerless?: boolean
  /** The body is a bordered box inset from the panel edge, not the panel's own
   *  width. Same reason as `notice`: the border and the margin are container
   *  geometry on the device, so a renderer that ignores this draws a screen
   *  the wearer is not looking at - and the whole point of the card is that it
   *  does not look like the other screens. */
  card?: boolean
} {
  // Said before anything else, because a run that is closing itself has no mode
  // left worth drawing. A WebView that simply vanishes is indistinguishable
  // from one that crashed, which is the thing the wearer has been seeing all
  // day; this is the app saying which of the two it was.
  if (state.fatal) return fatalScreen(state.fatal)
  switch (state.mode) {
    case 'session_list':
      // No header: the list screen gave that bar back to the list.
      return {
        header: '',
        notice: sessionListNotice(state) || undefined,
        body: sessionListBody(state),
        footer: sessionListFooter(state),
        headerless: true,
      }
    case 'conversation': {
      const { headerText, noticeText, bodyText, footerText } = conversationContent(state)
      return { header: headerText, notice: noticeText, body: bodyText, footer: footerText }
    }
    case 'choice':
      return { header: choiceHeader(state), body: choiceBody(state), footer: footerChoice(state) }
    case 'voice': {
      const { headerText, bodyText, footerText } = voiceContent(state)
      return { header: headerText, body: bodyText, footer: footerText }
    }
    case 'overlay': {
      const { headerText, bodyText, footerText } = overlayContent(state)
      return { header: headerText, body: bodyText, footer: footerText, card: true }
    }
  }
}

/**
 * The row that sends, last in a multi-select.
 *
 * A multi-select needs three verbs where a single pick needs two - check,
 * send, and leave - and there are four gestures, of which double-tap is spoken
 * for. It means "leave" on every screen in this app, and a picker where it
 * meant "send" instead would be the one place the wearer has to remember
 * something. So the third verb becomes a row: tap checks an option, tap on
 * this sends. It is not one of the pane's options, and swiping onto it sends
 * the pane no key.
 */
export const CHOICE_SEND = 'Send'

/** What the ring walks: the pane's options, and in a multi-select the row that
 *  sends them. Indexing is against this, not against `choiceOptions`. */
export function choiceRows(state: AppState): string[] {
  if (!state.choiceMulti) return state.choiceOptions
  const n = state.choiceOptions.filter(isChecked).length
  return [...state.choiceOptions, n > 0 ? `${CHOICE_SEND} (${n})` : CHOICE_SEND]
}

/** Whether the cursor is on the send row rather than on an option. */
export function onChoiceSend(state: AppState): boolean {
  return state.choiceMulti === true && state.choiceIndex >= state.choiceOptions.length
}

function choiceBody(state: AppState): string {
  const rows = choiceRowLines(state)
  return [...rows, ...choiceDetailLines(state, MAX_LINES - rows.length)].join('\n')
}

/**
 * The description of the option the ring is resting on, in the lines the rows
 * left over.
 *
 * There are usually plenty: three options take three of the panel's eight, and
 * the picker had been drawing three cut rows into a screen more than half
 * empty. The description used to arrive glued to its label and be cut with it,
 * a few characters in - so a wearer could read what the options were called and
 * nothing about what they meant, which is the part that decides between them.
 *
 * Under the rows rather than beside them: moving the ring is how the next one
 * is read, and a block that changes in place makes that obvious in a way a
 * column of truncations never did.
 */
function choiceDetailLines(state: AppState, spare: number): string[] {
  // A rule and at least one line of text, or it is not worth the rule.
  if (spare < 2) return []
  const text = state.choiceDetails?.[state.choiceIndex]
  if (!text) return []
  const lines = splitDisplayLines(stripUnrenderable(text)).slice(0, spare - 1)
  return lines.length > 0 ? [CARD_SEPARATOR, ...lines] : []
}

function choiceRowLines(state: AppState): string[] {
  return choiceRows(state).map((opt, i) => {
    const cursor = i === state.choiceIndex ? '>>>' : '   '
    // The rows come off a pane, so they carry whatever that agent chose to
    // draw with. A tick is the character this most depends on and the one the
    // firmware is least likely to have: claude writes U+2714 and kimi U+2713,
    // and neither has a glyph. Unsubstituted, the wearer's own ticks reach the
    // panel as tofu, while the simulator draws them beautifully from a browser
    // font - the exact divergence the simulator exists to make visible.
    const row = `${cursor} ${stripUnrenderable(opt)}`
    // One row, one line. Cut rather than wrapped: the count of rows has to
    // match the count of options, because the cursor is a position in that
    // list. A row is the label alone now, so the cut is a long label's problem
    // rather than every option's - the description is drawn below.
    return textWidth(row) > BODY_WIDTH ? ellipsize(row) : row
  })
}

/**
 * Full-screen presentation of one relay item. Swipe cycles the queue,
 * tap jumps to the item's session, double-tap dismisses.
 *
 * Questions and notifications share this screen because they are the same
 * gesture problem — one thing, full width, reachable from the ring. They part
 * ways in what happens when the wearer does nothing: a question waits, a
 * notification takes itself away (the controller's dismissal timer).
 */
function overlayContent(state: AppState): { headerText: string; bodyText: string; footerText: string } {
  // Waiting first, matching the queue's own ordering, so a question is never
  // buried behind an FYI that happens to be newer.
  const items = [...state.relayWaiting, ...state.relayInfo]
  const item = items.find((i) => i.id === state.overlayItemId) || items[0]
  if (!item) {
    return { headerText: withClock('Relay'), bodyText: '(none)', footerText: 'dbl:back' }
  }
  const idx = items.indexOf(item)
  const badge = item.kind === 'waiting' ? '[!]' : '[i]'
  // A counter over a queue of one says nothing, and the header is one line.
  const counter = items.length > 1 ? ` ${idx + 1}/${items.length}` : ''
  const headerText = withClock(`${relayLabel(state, item)} ${badge}${counter}`)

  // Wrapped to the card, not to the panel. The box is narrower than the body it
  // replaces, and text measured against the wider one runs under the border.
  const lines = splitLines(item.text, CARD_WIDTH)
  if (item.choices?.length) {
    lines.push(CARD_SEPARATOR)
    for (let i = 0; i < item.choices.length; i++) {
      lines.push(...splitLines(` ${i + 1}. ${item.choices[i]}`, CARD_WIDTH))
    }
  }
  const bodyText = lines.length > CARD_LINES
    ? [...lines.slice(0, CARD_LINES - 1), '…'].join('\n')
    : lines.join('\n')
  const next = items.length > 1 ? '  swipe:next' : ''
  // "later" is an answer to a question. A notification is not asking anything,
  // so the same gesture is just closing it.
  const footerText = item.kind === 'info'
    ? `tap:open  dbl:close${next}`
    : item.choices?.length
      ? `tap:choices  dbl:later${next}`
      : `tap:open  dbl:later${next}`
  return { headerText, bodyText, footerText }
}

function voiceContent(state: AppState): { headerText: string; bodyText: string; footerText: string } {
  const session = state.sessions[state.sessionIndex]
  const name = state.voiceSessionName || (session ? sName(session) : '---')
  // The tail every screen carries in a demo. The mic screens were the one place
  // it was missing, which is the worst place for it to be: a recording screen
  // that does not say DEMO is a recording screen claiming to be listening.
  const demoTail = state.demo ? DEMO_TAIL : ''
  switch (state.voicePhase) {
    case 'recording':
      return {
        headerText: withClock(`${name}  [recording]`, demoTail),
        bodyText: `● Recording\n\nSpeak into the microphone\nStops when you stop, or after ${Math.round(MAX_RECORDING_MS / 1000)} seconds`,
        footerText: 'tap:stop and transcribe  dbl:cancel',
      }
    case 'transcribing':
      return {
        headerText: withClock(`${name}  [transcribing]`, demoTail),
        bodyText: 'Transcribing...',
        footerText: 'dbl:cancel',
      }
    default: // 'confirm'
      return {
        headerText: withClock(`${name}  [confirm]`, demoTail),
        bodyText: state.voiceText
          ? state.voiceText
          : state.voiceFailed
            ? '(the transcription did not come back)\n\nSay it again - the recording was not the problem'
            : '(nothing was recognized)',
        footerText: state.voiceText ? 'tap:send  dbl:cancel' : 'dbl:back',
      }
  }
}

// ─── Page builders ───

/**
 * The list screen: two containers, not three.
 *
 * A title bar over a list of titles is a line spent saying nothing. The
 * counter and the clock it carried fit in the footer beside the gestures, and
 * the list gets the 36px — a whole extra row, which is what a list that now
 * includes panes needs.
 */
function buildSessionList(state: AppState): RebuildPageContainer {
  // The pinned notification, boxed. In the list's own column it read as one
  // more session name; a border and the panel showing round it do not.
  const noticeText = sessionListNotice(state)
  const nHeight = noticeText ? noticeHeight(1) : 0
  const notice = noticeText
    ? new TextContainerProperty({
        xPosition: 4, yPosition: 0,
        width: W - 8, height: nHeight,
        borderWidth: NOTICE_BORDER,
        borderColor: CARD_BORDER_COLOR,
        borderRadius: CARD_RADIUS,
        paddingLength: NOTICE_PAD,
        containerID: 1, containerName: 'notice',
        isEventCapture: 0,
        content: noticeText,
      })
    : null

  const list = new TextContainerProperty({
    xPosition: 4, yPosition: nHeight,
    width: W - 8, height: H - BAR_H - nHeight,
    borderWidth: 0,
    paddingLength: LIST_PAD,
    containerID: notice ? 2 : 1, containerName: 'list',
    isEventCapture: 0,
    content: sessionListBody(state),
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - BAR_H,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: notice ? 3 : 2, containerName: 'footer',
    isEventCapture: 1,
    content: sessionListFooter(state),
  })

  const objects = notice ? [notice, list, footer] : [list, footer]
  return new RebuildPageContainer({
    containerTotalNum: objects.length,
    textObject: objects,
  })
}

/**
 * How many lines the notice strip is showing, which is the only thing about
 * the conversation page whose *geometry* changes. Everything else is content,
 * and content goes out as an in-place upgrade; a different height needs the
 * page rebuilt, so `updateDisplay` watches this.
 */
function noticeLineCount(state: AppState): number {
  const { noticeText } = conversationContent(state)
  return noticeText ? noticeText.split('\n').length : 0
}

/**
 * How tall the notification card is, in lines. The same job `noticeLineCount`
 * does for the conversation: the card is drawn to fit its message, so a shorter
 * notification replacing a longer one is a change of geometry, not of text, and
 * upgrading the string in place would leave the border where the old message
 * ended.
 */
function cardLineCount(state: AppState): number {
  return overlayContent(state).bodyText.split('\n').length
}

function buildConversation(state: AppState): RebuildPageContainer {
  const { headerText, noticeText, bodyText, footerText } = conversationContent(state)
  const nLines = noticeText ? noticeText.split('\n').length : 0
  const nHeight = noticeHeight(nLines)

  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: headerText,
  })

  // The strip and its border are what used to be a row of dashes. Drawn by the
  // panel, the rule costs NOTICE_BORDER px where the dashes cost a 27px line.
  const notice = nLines > 0
    ? new TextContainerProperty({
        xPosition: 4, yPosition: BAR_H,
        width: W - 8, height: nHeight,
        borderWidth: NOTICE_BORDER,
        borderColor: NOTICE_BORDER_COLOR,
        borderRadius: 0,
        paddingLength: NOTICE_PAD,
        containerID: 2, containerName: 'notice',
        isEventCapture: 0,
        content: noticeText,
      })
    : null

  const body = new TextContainerProperty({
    xPosition: 4, yPosition: BAR_H + nHeight,
    width: W - 8, height: H - 2 * BAR_H - nHeight,
    borderWidth: 0,
    paddingLength: BODY_PAD,
    containerID: notice ? 3 : 2, containerName: 'body',
    isEventCapture: 0,
    content: bodyText,
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - BAR_H,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: notice ? 4 : 3, containerName: 'footer',
    isEventCapture: 1,
    content: footerText,
  })

  const objects = notice ? [header, notice, body, footer] : [header, body, footer]
  return new RebuildPageContainer({
    containerTotalNum: objects.length,
    textObject: objects,
  })
}

function buildChoice(state: AppState): RebuildPageContainer {
  // Header - action required
  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: choiceHeader(state),
  })

  const body = new TextContainerProperty({
    xPosition: 4, yPosition: BAR_H,
    width: W - 8, height: H - 2 * BAR_H,
    borderWidth: 0,
    paddingLength: BODY_PAD,
    containerID: 2, containerName: 'body',
    isEventCapture: 0,
    content: choiceBody(state),
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - BAR_H,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: 3, containerName: 'footer',
    isEventCapture: 1,
    // Not the constant: a multi-select's tap does one of two things depending
    // on the row, and the footer that says so was only ever reaching
    // `screenText`. The device drew the single-pick promise over the picker
    // that does not keep it.
    content: footerChoice(state),
  })

  return new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [header, body, footer],
  })
}

function buildVoice(state: AppState): RebuildPageContainer {
  const { headerText, bodyText, footerText } = voiceContent(state)

  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: headerText,
  })

  const body = new TextContainerProperty({
    xPosition: 4, yPosition: BAR_H,
    width: W - 8, height: H - 2 * BAR_H,
    borderWidth: 0,
    paddingLength: BODY_PAD,
    containerID: 2, containerName: 'body',
    isEventCapture: 0,
    content: bodyText,
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - BAR_H,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: 3, containerName: 'footer',
    isEventCapture: 1,
    content: footerText,
  })

  return new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [header, body, footer],
  })
}

function buildOverlay(state: AppState): RebuildPageContainer {
  const { headerText, bodyText, footerText } = overlayContent(state)

  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: headerText,
  })

  // The card. Sized to its message, centred, and bordered - so what the wearer
  // sees is a box laid over the panel rather than another screen filling it,
  // which is what a notification kept being mistaken for.
  const box = cardBox(bodyText.split('\n').length)
  const body = new TextContainerProperty({
    xPosition: box.x, yPosition: box.y,
    width: box.w, height: box.h,
    borderWidth: CARD_BORDER,
    borderColor: CARD_BORDER_COLOR,
    borderRadius: CARD_RADIUS,
    paddingLength: BODY_PAD,
    containerID: 2, containerName: 'card',
    isEventCapture: 0,
    content: bodyText,
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - BAR_H,
    width: W, height: BAR_H,
    borderWidth: 0,
    paddingLength: HEADER_PAD,
    containerID: 3, containerName: 'footer',
    isEventCapture: 1,
    content: footerText,
  })

  return new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [header, body, footer],
  })
}

export function buildSetupGuide(): RebuildPageContainer {
  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: W, height: 28,
    paddingLength: HEADER_PAD,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: __PRODUCT_NAME__,
  })

  const body = new TextContainerProperty({
    xPosition: 4, yPosition: 32,
    width: W - 8, height: 228,
    borderWidth: 1,
    borderColor: 6,
    borderRadius: 3,
    paddingLength: BODY_PAD,
    containerID: 2, containerName: 'body',
    isEventCapture: 0,
    content: `${__PRODUCT_NAME__} not connected\n\nOpen this app from the Even Hub app on your phone and set the ${__PRODUCT_NAME__} URL\n\n1. Start ${__PRODUCT_NAME__} on your PC\n2. Enter the URL in the phone app\n3. Launch it again from the glasses`,
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - 24,
    width: W, height: 24,
    paddingLength: HEADER_PAD,
    containerID: 3, containerName: 'footer',
    isEventCapture: 1,
    // The gesture is live here now, so the footer can promise it. Before, a
    // wearer with no server had no way out of this screen at all.
    content: 'tap:see how it works                                   dbl:exit',
  })

  return new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [header, body, footer],
  })
}

// ─── Display controller ───

/** `StartUpPageCreateResult`, spelled out rather than read off the enum: it is
 *  declared in the SDK's .d.ts and its runtime shape is not ours to rely on. */
const CREATE_RESULT_NAMES: Record<number, string> = {
  0: 'success',
  1: 'invalid',
  2: 'oversize',
  3: 'outOfMemory',
}

let currentMode: Mode | null = null
/** Notice-strip height last sent, so a change in it triggers the rebuild the
 *  new geometry needs. */
let currentNoticeLines = 0
/** The same, for the notification card, which is drawn to fit its message. */
let currentCardLines = 0

/**
 * Get the bridge and put the first frame on the panel.
 *
 * `onBridge` runs the moment the bridge resolves and before the startup
 * container is built, which is the only place a one-shot subscription can be
 * registered in time. The host pushes the launch source once when loading
 * completes and the SDK keeps no copy of it — `onLaunchSource` is a plain
 * event subscription with no cached getter beside it, so a listener attached
 * after the push never learns the answer. Creating the container first costs a
 * round trip to the host, and subscribing on the far side of it is what the
 * SDK's own troubleshooting entry means by "register `onLaunchSource` early".
 *
 * A throwing callback must not cost us the panel, so it is contained here.
 */
export async function initDisplay(
  onBridge?: (bridge: Bridge) => void,
): Promise<Bridge | null> {
  try {
    const bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bridge timeout')), 5000)),
    ])

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
          content: `${__PRODUCT_NAME__}\nConnecting...`,
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
    // that would explain a run dying sooner than the one before it. It was
    // being discarded, so every theory about why the app stops had to be built
    // from symptoms instead of from what the host actually said.
    traceSink?.(
      `page container created: ${CREATE_RESULT_NAMES[created as number] ?? `unknown(${created})`}`,
      created === 0 ? 'info' : 'error',
    )
    return bridge
  } catch (e) {
    console.log('[display] Even Hub SDK not available — debug mode', e)
    return null
  }
}

/**
 * Redraw the header alone.
 *
 * The spinner changes nothing else, and a full update sends three containers
 * where one will do — three times the traffic, every tick, for the whole time
 * a session is working.
 */
/**
 * What each container was last told to show, so an upgrade that would change
 * nothing is not sent at all.
 *
 * The screen was redrawn on every `sessions-updated` push — every five
 * seconds, whether or not anything on it had changed. Measured on the device
 * that is 0.2 full draws a second, indefinitely, over BLE, for a panel showing
 * exactly what it showed five seconds ago. What actually changes on an idle
 * list is the clock in the footer, once a minute.
 *
 * Recorded only after the device has taken the write, so an upgrade that fails
 * is retried on the next render rather than assumed applied.
 */
const drawn = new Map<number, string>()

/**
 * Container writes actually sent to the panel.
 *
 * Reported on the heartbeat next to the frame count, because they are no
 * longer the same number and the difference is the whole point: a frame that
 * changes nothing now costs nothing, and only this counter says so from the
 * device rather than from reasoning about the code.
 */
let writes = 0
export function panelWrites(): number {
  return writes
}

/**
 * What the host said about the writes we sent it.
 *
 * Every draw call in the SDK returns a boolean, and every one of them was
 * being thrown away. That cost more than a missing log line: `drawn` cached
 * refused content as if it were on screen, so the retry the record above
 * promises never happened — a dropped write became a permanently stale
 * container. Only an explicit `false` counts as a refusal; the SDK's stubs
 * resolve with nothing, and reading that as a drop would stop the panel
 * updating at all.
 */
let drops = 0
export function panelDrops(): number {
  return drops
}

/**
 * Where display-layer traces go.
 *
 * `trace` lives in main.ts and importing it here would close an import cycle,
 * so main injects it instead. Unset in the simulator and in tests, where the
 * counters above are read directly.
 */
let traceSink: ((message: string, level?: string) => void) | null = null
export function setPanelTrace(fn: (message: string, level?: string) => void): void {
  traceSink = fn
}

/** First few drops are reported as they happen; after that the heartbeat's
 *  running count is enough, and a refusing host would otherwise fill the log. */
const TRACED_DROPS_MAX = 5
let tracedDrops = 0

/**
 * Give up on a panel that keeps saying no.
 *
 * The exit handlers are the intended way to stop drawing; this is the backstop
 * for when they do not run. One recorded case had the refusals start *before*
 * the exit event arrived — the host revoked the container first and said so
 * afterwards — and another produced 541 refused writes in eight minutes with no
 * exit event at all. Both look identical from here: every write refused, one
 * after another, for as long as the app is left running.
 *
 * A run of refusals is not a transient failure. The panel is gone, and the only
 * thing continuing to draw achieves is BLE traffic and a log nobody can read.
 * Ten in a row is well past any plausible hiccup and still cheap.
 *
 * Cleared by `invalidatePanel`, which is what a foreground re-entry calls: a
 * host that refused us while another app held the display may well accept the
 * next write, and the app should come back rather than stay blind for good.
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
      `host refused ${consecutiveDrops} writes in a row — no longer drawing (drops=${drops})`,
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

/** Send a container's new content, or nothing if that is what it already
 *  shows. Returns null when there was nothing to send. */
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

/**
 * Take note of what a rebuild just put on screen.
 *
 * Container ids mean different things in different modes — id 1 is the list on
 * one screen and the header on another — so the record is only ever read
 * between rebuilds, and every rebuild replaces it wholesale.
 */
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
 * only thing writing to the panel. Across a suspend the host may have taken
 * the page down, and a stale record would then skip exactly the writes needed
 * to put it back — a blank screen that no amount of waiting fixes, which is a
 * far worse failure than the one rebuild this costs on every resume.
 */
function forgetDrawn(): void {
  drawn.clear()
  currentMode = null
  currentNoticeLines = 0
  currentCardLines = 0
}

export function invalidatePanel(): void {
  forgetDrawn()
  // A resume is the one moment worth trying a panel that was refusing us: the
  // refusals were most likely another app holding the display, and that app has
  // just handed it back.
  //
  // Only here. A refused *rebuild* also forgets what is on screen, and doing it
  // through this function meant every refusal reset the run of refusals that was
  // supposed to add up — a host refusing everything never reached the limit,
  // which is precisely the case the limit exists for.
  consecutiveDrops = 0
  gaveUp = false
}

export async function updateHeader(bridge: Bridge | null, state: AppState): Promise<void> {
  if (!bridge || gaveUp || state.mode !== currentMode) return
  // Whichever container the spinner lives in — the conversation's header, or
  // the list's rows. One container either way; a full update sends three.
  if (state.mode === 'session_list') {
    // Container 1 is the notice when there is one; the rows are behind it.
    await upgrade(bridge, sessionListNotice(state) ? 2 : 1, 'list', sessionListBody(state))
    return
  }
  const { headerText } = conversationContent(state)
  await upgrade(bridge, 1, 'header', headerText)
}

export async function updateDisplay(bridge: Bridge | null, state: AppState): Promise<void> {
  if (!bridge || gaveUp) return

  // Geometry, not content, is what forces a rebuild: the notice strip changes
  // the body container's height and the ids below it, and the notification card
  // is sized to its own message. Content alone goes out as in-place upgrades,
  // which is why the panel is not rebuilt every render.
  // The list's notice is one row or none, but its presence shifts every
  // container id below it - so it is watched the same way the strip's height is.
  const notice =
    state.mode === 'conversation'
      ? noticeLineCount(state)
      : state.mode === 'session_list'
        ? (sessionListNotice(state) ? 1 : 0)
        : 0
  const card = state.mode === 'overlay' ? cardLineCount(state) : 0
  const needsRebuild =
    state.mode !== currentMode || notice !== currentNoticeLines || card !== currentCardLines
  currentMode = state.mode
  currentNoticeLines = notice
  currentCardLines = card

  if (needsRebuild) {
    let container: RebuildPageContainer
    switch (state.mode) {
      case 'session_list': container = buildSessionList(state); break
      case 'conversation': container = buildConversation(state); break
      case 'choice': container = buildChoice(state); break
      case 'voice': container = buildVoice(state); break
      case 'overlay': container = buildOverlay(state); break
    }
    const ok = await bridge.rebuildPageContainer(container)
    if (ok === false) {
      noteDrop('rebuild')
      // The mode was recorded above on the assumption this would land. Undo
      // that, or the next render sees the geometry as already sent and skips
      // the rebuild — leaving the panel showing the previous screen for good.
      // `forgetDrawn` rather than `invalidatePanel`: a refusal is not the host
      // handing the panel back, so it must not clear the run of refusals.
      forgetDrawn()
      return
    }
    recordRebuild(container)
    return
  }

  // In-place text updates. Each one is sent only if it would change what the
  // container is already showing; `Promise.all` over the ones that survive.
  switch (state.mode) {
    case 'session_list': {
      // The notice takes container 1 when it is there, pushing the other two
      // along. Sending the list to a fixed id would write it into the notice.
      const n = sessionListNotice(state)
      await Promise.all([
        ...(n ? [upgrade(bridge, 1, 'notice', n)] : []),
        upgrade(bridge, n ? 2 : 1, 'list', sessionListBody(state)),
        // The footer moves now — it holds the clock and the position.
        upgrade(bridge, n ? 3 : 2, 'footer', sessionListFooter(state)),
      ])
      break
    }
    case 'conversation': {
      const { headerText, noticeText, bodyText, footerText } = conversationContent(state)
      const hasNotice = notice > 0
      await Promise.all([
        upgrade(bridge, 1, 'header', headerText),
        ...(hasNotice ? [upgrade(bridge, 2, 'notice', noticeText)] : []),
        upgrade(bridge, hasNotice ? 3 : 2, 'body', bodyText),
        upgrade(bridge, hasNotice ? 4 : 3, 'footer', footerText),
      ])
      break
    }
    case 'choice': {
      await Promise.all([
        upgrade(bridge, 1, 'header', choiceHeader(state)),
        upgrade(bridge, 2, 'body', choiceBody(state)),
      ])
      break
    }
    case 'voice': {
      const { headerText, bodyText, footerText } = voiceContent(state)
      await Promise.all([
        upgrade(bridge, 1, 'header', headerText),
        upgrade(bridge, 2, 'body', bodyText),
        upgrade(bridge, 3, 'footer', footerText),
      ])
      break
    }
    case 'overlay': {
      const { headerText, bodyText, footerText } = overlayContent(state)
      await Promise.all([
        upgrade(bridge, 1, 'header', headerText),
        upgrade(bridge, 2, 'body', bodyText),
        upgrade(bridge, 3, 'footer', footerText),
      ])
      break
    }
  }
}

// ─── Events ───

/**
 * The host's own account of why it is stopping us.
 *
 * `systemExitReasonCode` is printed even when it is zero, because zero is an
 * answer and absent is a different one — the protobuf omits zero values on the
 * wire, so a missing key and a genuine `0` arrive identically and only the raw
 * object can tell them apart. That distinction has already cost a day here:
 * `isWearing` reads `false` for both "not worn" and "not reported", and it was
 * read as the former.
 */
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
    /** The app came back to the foreground. Its JS may have been suspended for
     *  any length of time, so anything time-sensitive is now stale. */
    onForegroundEnter?: () => void
    /** Going away. Whatever should survive has to be written now. */
    onForegroundExit?: () => void
    /**
     * The host is tearing the app down and says why.
     *
     * `detail` is the rest of what it said. `SYSTEM_EXIT_EVENT` is sent both
     * when the wearer confirms the host's exit dialogue and when the host
     * decides on its own, so `kind` alone cannot separate the two — and fifteen
     * exits were recorded without the app ever having asked for one.
     * `systemExitReasonCode` and `eventSource` are the only host-side answer to
     * which it was, and both were being discarded.
     */
    onExit?: (kind: 'abnormal' | 'system', detail?: string) => void
  },
): () => void {
  if (!bridge) return () => {}
  let lastEventTime = 0
  const EVENT_DEBOUNCE = 300

  // The SDK returns an unsubscribe function and this call was dropping it, so
  // there was no way to stop listening — the handler stayed live after the host
  // tore the app down, turning every stray event into more work for a page that
  // no longer had a display. Returned rather than used here: the caller is the
  // one that learns the app is going away.
  return bridge.onEvenHubEvent((event) => {
    // Mic PCM arrives on the same event channel; route it out before ring handling.
    // Runtime shape may be Uint8Array, number[], or base64 string (host/JSON dependent).
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

    const raw = JSON.stringify(event).slice(0, 80)
    callbacks.onRawEvent?.(raw)

    const textType = event.textEvent?.eventType
    const sysType = event.sysEvent?.eventType
    const listType = event.listEvent?.eventType
    const eventType = textType ?? sysType ?? listType

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

    // Lifecycle, handled before the ring debounce: these are not gestures, and
    // letting them share the debounce would have a resume swallow the tap that
    // follows it. The host reports its own reason for stopping us, which is
    // the difference between "backgrounded" and "killed".
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

    // Ring tap: sysEvent with undefined eventType
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
      case OsEventTypeList.CLICK_EVENT: callbacks.onTap(); break
      case OsEventTypeList.DOUBLE_CLICK_EVENT: callbacks.onDoubleTap(); break
    }
  })
}
