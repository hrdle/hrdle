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
  HEADER_WIDTH,
  LINE_H,
  LIST_LINES,
  MAX_LINES,
  PANEL_H,
  SPACE_W,
  ellipsize,
  splitLines,
  textWidth,
} from './metrics.ts'
import { formatMessage, recapBlockLines } from './types.ts'
import type { Session, Pane, ConversationMessage, GlassesRelayItem } from './types.ts'

const W = 576
const H = 288

export type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>
type Mode = 'session_list' | 'conversation' | 'choice' | 'voice' | 'overlay'
export type VoicePhase = 'recording' | 'transcribing' | 'confirm'

/** Break text into the lines the body container will show. */
function splitDisplayLines(text: string): string[] {
  return splitLines(text, BODY_WIDTH)
}

/** Paginate a single message by display lines */
function paginateSingleMessage(fullText: string, page: number): { text: string; pageInfo: string; totalPages: number } {
  const allLines = splitDisplayLines(fullText)

  if (allLines.length <= MAX_LINES) {
    return { text: fullText, pageInfo: '', totalPages: 1 }
  }

  // Pages tile: no line appears twice. Carrying the last line over as context
  // sounded helpful and read as the page not having advanced — the reader has
  // to work out which of the seven lines is the one they already know.
  const totalPages = Math.ceil(allLines.length / MAX_LINES)
  const p = Math.min(page, totalPages - 1)
  const start = p * MAX_LINES
  const pageLines = allLines.slice(start, start + MAX_LINES)
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
function paginateMessage(msgs: ConversationMessage[], msgIndex: number, page: number): { text: string; pageInfo: string; totalPages: number; multiCount: number } {
  if (msgIndex < 0) return { text: '(no messages)', pageInfo: '', totalPages: 0, multiCount: 0 }

  if (page === 0) {
    const { text, count } = buildMultiMessageViewFrom(msgs, msgIndex)
    if (count > 1) {
      return { text, pageInfo: '', totalPages: 1, multiCount: count }
    }
  }

  const fullText = formatMessage(msgs[msgIndex])
  const result = paginateSingleMessage(fullText, page)
  return { ...result, multiCount: 1 }
}

/** Get total pages for the message at a given offset */
export function getTotalPagesAt(msgs: ConversationMessage[], offset: number): number {
  const msgIndex = msgs.length > 0 ? Math.max(0, msgs.length - 1 - offset) : -1
  if (msgIndex < 0) return 0
  const { totalPages } = paginateMessage(msgs, msgIndex, 0)
  return totalPages
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
  /** Pane the cursor is on, when the list row is a pane rather than its
   *  workspace. Carries into the conversation: its own agent session, its own
   *  status, and the pane replies are routed to. */
  selectedPaneId?: string
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
  // ── Glasses relay channel (#504) ──
  /** Active waiting items, priority order (first = shown in the overlay). */
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
function withClock(title: string, tail = ''): string {
  const now = new Date()
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const clockPx = textWidth(clock)
  const build = (h: string, spaces: number) => `${h}${tail}${' '.repeat(spaces)}${clock}`
  let head = title
  while (head && textWidth(head + tail) + SPACE_W + clockPx > HEADER_WIDTH) head = head.slice(0, -1)
  let spaces = Math.max(1, Math.floor((HEADER_WIDTH - textWidth(head + tail) - clockPx) / SPACE_W))
  // Kerning across the join can cost a pixel or two; give it back rather than
  // hand the container a line it has to wrap.
  let out = build(head, spaces)
  while (spaces > 1 && textWidth(out) > HEADER_WIDTH) {
    spaces--
    out = build(head, spaces)
  }
  // One space is the floor, and measuring the parts separately can still land
  // a pixel or two over once they are joined. Past that the title yields —
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

function statusLabel(s: Session, frame: string): string {
  return s.indicatorState === 'processing' ? frame : BADGE_BLANK
}

const SEPARATOR = '-'.repeat(24)

/**
 * The working indicator, one frame per tick.
 *
 * A static mark says the session was working when the screen was last drawn;
 * a moving one says it is working now, which is the question being asked. The
 * frames are all 320 units wide — an uneven set shifts everything after it on
 * each turn and reads as a shiver rather than a rotation, which is what ruled
 * out the ASCII `|/-\` and the Braille spinner the CLI world uses (the
 * firmware has no glyphs for the latter at all).
 */
const SPINNER = ['▲', '▶', '▼', '◀']

/** Slow on purpose: each frame costs a BLE round trip, and the question is
 *  only whether something is alive. */
export const SPINNER_INTERVAL_MS = 3000

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

/** Waiting/info banner prepended to the TOP of the conversation tab (#504).
 *  Waiting-first is the core philosophy: the highest-priority waiting item
 *  always heads the view; an info item shows only when nothing is waiting. */
function relayBannerLines(state: AppState): string[] {
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
export function listRows(sessions: Session[]): ListRow[] {
  const rows: ListRow[] = []
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
export function selectableRows(sessions: Session[]): ListRow[] {
  return listRows(sessions).filter((r) => !r.header)
}

/** Index of the row the cursor is on. */
export function rowCursor(state: AppState): number {
  const rows = listRows(state.sessions)
  const found = rows.findIndex(
    (r) => !r.header && r.sessionIndex === state.sessionIndex && r.paneId === state.selectedPaneId,
  )
  if (found >= 0) return found
  // Landed on a workspace that turned out to have panes — a fresh state, or a
  // pane count that grew underneath. Its first pane is what the row meant.
  const fallback = rows.findIndex((r) => !r.header && r.sessionIndex === state.sessionIndex)
  return fallback >= 0 ? fallback : 0
}

function paneStatusLabel(p: Pane, frame: string): string {
  return p.indicatorState === 'processing' ? frame : BADGE_BLANK
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

function paneDetail(p: Pane, siblings: Pane[]): string {
  const dirOf = (x: Pane) => x.currentPath?.split('/').filter(Boolean).pop() ?? ''
  const dirs = new Set(siblings.map(dirOf))
  const pct = p.metrics?.contextPercent
  // Which tab a pane sits in is not shown. It was, while a reply to one in
  // another tab could not land — a mark for "readable but unanswerable". The
  // server switches tabs to deliver now, so the pane behaves like any other
  // and the label would be a fact with no decision attached to it.
  return [pct != null ? `${Math.round(pct)}%` : '', dirs.size > 1 ? dirOf(p) : '']
    .filter(Boolean)
    .join('  ')
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
function listInfoBanner(state: AppState): string[] {
  const info = state.relayInfo[0]
  if (!info) return []
  // The count goes next to the label, not after the text: the text is what
  // gets cut at the panel edge, and "+2" is the part that must survive.
  const more = state.relayInfo.length > 1 ? `+${state.relayInfo.length - 1}` : ''
  const wrapped = splitDisplayLines(`[i]${relayLabel(state, info)}${more}: ${info.text}`)
  const line = wrapped[0] || ''
  if (!line) return []
  // A message cut at the panel edge with nothing to show for it reads as a
  // complete, and wrong, sentence. Opening the session shows the rest.
  return [wrapped.length > 1 ? ellipsize(line) : line]
}

function sessionListBody(state: AppState): string {
  const { sessions } = state
  // Relay waiting covers agent-declared items whose session indicator is not
  // waiting_input; those sessions still get the [!] marker.
  const relayWaitingIds = new Set(state.relayWaiting.map((i) => i.sessionId))
  const frame = spinnerFrame(state)
  const banner = listInfoBanner(state)
  const listLines = LIST_LINES - banner.length
  const rows = listRows(sessions)
  if (!rows.length) return [...banner, '(no sessions)'].join('\n')
  const cursor = rowCursor(state)
  const start = Math.max(0, Math.min(cursor - 3, rows.length - listLines))
  const visible = rows.slice(Math.max(0, start), Math.max(0, start) + listLines)

  const listBody = visible.map((row, i) => {
    const idx = Math.max(0, start) + i
    const here = idx === cursor ? '>' : ' '
    const s = sessions[row.sessionIndex]
    // Pad the badge so every name starts in the same column: a list where
    // `>[!] name` and `  name` begin three columns apart is hard to scan.
    if (row.header || !row.paneId) {
      // A relay item is a question already asked and still unanswered, which
      // outlives the indicator that raised it; that one keeps its mark.
      const label = relayWaitingIds.has(s.id) ? '！' : statusLabel(s, frame)
      // A heading takes no cursor, so it never carries the marker.
      return `${row.header ? ' ' : here}${label} ${sName(s)}`
    }
    const panes = s.panes ?? []
    const p = panes.find((x) => x.paneId === row.paneId)
    const detail = p ? paneDetail(p, panes) : ''
    // Drawn as a tree so the panes read as belonging to the name above them
    // rather than as more workspaces that happen to be indented. The firmware
    // carries the light box-drawing set at full width, so the branch lines up
    // with the badges either side of it.
    const last = panes[panes.length - 1]?.paneId === row.paneId
    const branch = last ? '└' : '├'
    return `${here}${p ? paneStatusLabel(p, frame) : BADGE_BLANK}${branch} ${paneName(p, row.paneId)}${detail ? `  ${detail}` : ''}`
  })

  return [...banner, ...listBody].join('\n')
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
  const recap = onLatest && recapIsCurrent(recapAt, state.conversation) ? recapBlock(recapText) : []
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

  const msgs = state.conversation
  const msgIndex = msgs.length > 0
    ? Math.max(0, msgs.length - 1 - state.conversationOffset)
    : -1
  const { text: convText, pageInfo } = paginateMessage(msgs, msgIndex, state.conversationPage)
  const allNotice = conversationNoticeText(state)
  // The body container clips overflow: cap the banner+recap+content block at
  // one page so a waiting overlay never pushes conversation text off-screen.
  // Everything is measured in display lines — counting the conversation in
  // logical lines let a wrapped paragraph run off the bottom unnoticed.
  const content = convText.split('\n').flatMap(splitDisplayLines)
  // The notice block gets its own container so the panel can draw the line
  // between them as a border. It used to be a row of dashes inside this one,
  // which spent 27px — a seventh of everything the reader gets — on a rule.
  const noticeLines = noticeScrollOf(allNotice, state.noticeWindow ?? 0)
  const noticeText = noticeLines.join('\n')
  // The body container clips overflow: cap the content at what is left once
  // the notice has taken its share, so a waiting banner never pushes
  // conversation text off-screen. Everything is measured in display lines —
  // counting the conversation in logical lines let a wrapped paragraph run off
  // the bottom unnoticed.
  const bodyText = content.slice(0, conversationLines(noticeLines.length)).join('\n')
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
      `${statusBadge}${noticeMark}`,
    ),
    bodyText,
    footerText: pageInfo ? `${action}  ${pageInfo.trim()}` : action,
  }
}

// Footers that are fixed per mode (the rest are built with their content).
// Named so the browser simulator renders the same string the G2 does instead
// of a hand-copied approximation.
/** Everything the list screen has to say, in the one bar it still has. */
function sessionListFooter(state: AppState): string {
  // Counted among what can be opened; headings are not places to be.
  const rows = listRows(state.sessions)
  const at = rows[rowCursor(state)]
  const selectable = rows.filter((r) => !r.header)
  const cursor = selectable.findIndex((r) => r === at) + 1
  const total = selectable.length
  const badge = state.relayWaiting.length > 0 ? `  !${state.relayWaiting.length}` : ''
  return withClock(`tap:open  swipe:nav  ${cursor}/${total}${badge}`)
}
const FOOTER_CHOICE = 'swipe:select  tap:confirm  dbl:skip'

/** Reply target shown in the choice header — the session the Enter actually
 *  goes to, which differs from the selected one when answering a relay item
 *  for another session. */
function choiceHeader(state: AppState): string {
  const session = state.sessions[state.sessionIndex]
  const name = state.choiceSessionName || (session ? sName(session) : '---')
  return withClock(`${name}  [SELECT]`)
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
} {
  switch (state.mode) {
    case 'session_list':
      // No header: the list screen gave that bar back to the list.
      return { header: '', body: sessionListBody(state), footer: sessionListFooter(state), headerless: true }
    case 'conversation': {
      const { headerText, noticeText, bodyText, footerText } = conversationContent(state)
      return { header: headerText, notice: noticeText, body: bodyText, footer: footerText }
    }
    case 'choice':
      return { header: choiceHeader(state), body: choiceBody(state), footer: FOOTER_CHOICE }
    case 'voice': {
      const { headerText, bodyText, footerText } = voiceContent(state)
      return { header: headerText, body: bodyText, footer: footerText }
    }
    case 'overlay': {
      const { headerText, bodyText, footerText } = overlayContent(state)
      return { header: headerText, body: bodyText, footer: footerText }
    }
  }
}

function choiceBody(state: AppState): string {
  return state.choiceOptions.map((opt, i) => {
    const cursor = i === state.choiceIndex ? '>>>' : '   '
    return `${cursor} ${opt}`
  }).join('\n')
}

/**
 * Full-screen presentation of one relay item (#504). Swipe cycles the queue,
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

  const lines = splitDisplayLines(item.text)
  if (item.choices?.length) {
    lines.push(SEPARATOR)
    for (let i = 0; i < item.choices.length; i++) {
      lines.push(...splitDisplayLines(` ${i + 1}. ${item.choices[i]}`))
    }
  }
  const bodyText = lines.length > MAX_LINES
    ? [...lines.slice(0, MAX_LINES - 1), '…'].join('\n')
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
  switch (state.voicePhase) {
    case 'recording':
      return {
        headerText: withClock(`${name}  [recording]`),
        bodyText: '● Recording\n\nSpeak into the microphone',
        footerText: 'tap:stop and transcribe  dbl:cancel',
      }
    case 'transcribing':
      return {
        headerText: withClock(`${name}  [transcribing]`),
        bodyText: 'Transcribing...',
        footerText: 'dbl:cancel',
      }
    default: // 'confirm'
      return {
        headerText: withClock(`${name}  [confirm]`),
        bodyText: state.voiceText ? state.voiceText : '(nothing was recognized)',
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
  const list = new TextContainerProperty({
    xPosition: 4, yPosition: 0,
    width: W - 8, height: H - 36,
    borderWidth: 0,
    paddingLength: 6,
    containerID: 1, containerName: 'list',
    isEventCapture: 0,
    content: sessionListBody(state),
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - 36,
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 2, containerName: 'footer',
    isEventCapture: 1,
    content: sessionListFooter(state),
  })

  return new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [list, footer],
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

function buildConversation(state: AppState): RebuildPageContainer {
  const { headerText, noticeText, bodyText, footerText } = conversationContent(state)
  const nLines = noticeText ? noticeText.split('\n').length : 0
  const nHeight = noticeHeight(nLines)

  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: headerText,
  })

  // The strip and its border are what used to be a row of dashes. Drawn by the
  // panel, the rule costs NOTICE_BORDER px where the dashes cost a 27px line.
  const notice = nLines > 0
    ? new TextContainerProperty({
        xPosition: 4, yPosition: 36,
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
    xPosition: 4, yPosition: 36 + nHeight,
    width: W - 8, height: H - 36 - 36 - nHeight,
    borderWidth: 0,
    paddingLength: 6,
    containerID: notice ? 3 : 2, containerName: 'body',
    isEventCapture: 0,
    content: bodyText,
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - 36,
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
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
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: choiceHeader(state),
  })

  const body = new TextContainerProperty({
    xPosition: 4, yPosition: 36,
    width: W - 8, height: H - 36 - 36,
    borderWidth: 0,
    paddingLength: 6,
    containerID: 2, containerName: 'body',
    isEventCapture: 0,
    content: choiceBody(state),
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - 36,
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 3, containerName: 'footer',
    isEventCapture: 1,
    content: FOOTER_CHOICE,
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
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: headerText,
  })

  const body = new TextContainerProperty({
    xPosition: 4, yPosition: 36,
    width: W - 8, height: H - 36 - 36,
    borderWidth: 0,
    paddingLength: 6,
    containerID: 2, containerName: 'body',
    isEventCapture: 0,
    content: bodyText,
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - 36,
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
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
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: headerText,
  })

  const body = new TextContainerProperty({
    xPosition: 4, yPosition: 36,
    width: W - 8, height: H - 36 - 36,
    borderWidth: 0,
    paddingLength: 6,
    containerID: 2, containerName: 'body',
    isEventCapture: 0,
    content: bodyText,
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - 36,
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
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
    paddingLength: 4,
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
    paddingLength: 6,
    containerID: 2, containerName: 'body',
    isEventCapture: 0,
    content: `${__PRODUCT_NAME__} not connected\n\nOpen this app from the Even Hub app on your phone and set the ${__PRODUCT_NAME__} URL\n\n1. Start ${__PRODUCT_NAME__} on your PC\n2. Enter the URL in the phone app\n3. Launch it again from the glasses`,
  })

  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - 24,
    width: W, height: 24,
    paddingLength: 4,
    containerID: 3, containerName: 'footer',
    isEventCapture: 1,
    content: 'Setup from phone app',
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

export async function initDisplay(): Promise<Bridge | null> {
  try {
    const bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bridge timeout')), 5000)),
    ])

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
    await upgrade(bridge, 1, 'list', sessionListBody(state))
    return
  }
  const { headerText } = conversationContent(state)
  await upgrade(bridge, 1, 'header', headerText)
}

export async function updateDisplay(bridge: Bridge | null, state: AppState): Promise<void> {
  if (!bridge || gaveUp) return

  // Geometry, not content, is what forces a rebuild: the notice strip changes
  // the body container's height and the ids below it. Content alone goes out
  // as in-place upgrades, which is why the panel is not rebuilt every render.
  const notice = state.mode === 'conversation' ? noticeLineCount(state) : 0
  const needsRebuild = state.mode !== currentMode || notice !== currentNoticeLines
  currentMode = state.mode
  currentNoticeLines = notice

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
      await Promise.all([
        upgrade(bridge, 1, 'list', sessionListBody(state)),
        // The footer moves now — it holds the clock and the position.
        upgrade(bridge, 2, 'footer', sessionListFooter(state)),
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
