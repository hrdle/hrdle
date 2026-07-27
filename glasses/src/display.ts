import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'
import { PANEL_WIDTH, formatMessage, recapBlockLines } from './types.ts'
import type { Session, ConversationMessage, GlassesRelayItem } from './types.ts'

const W = 576
const H = 288

export type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>
type Mode = 'session_list' | 'conversation' | 'choice' | 'voice' | 'overlay'
export type VoicePhase = 'recording' | 'transcribing' | 'confirm'

// Display metrics (measured on actual G2 hardware)
// Body container: 568x210, border=0, padding=6 → effective 556x198
const LINE_WIDTH = PANEL_WIDTH   // max half-width (ASCII) chars per line
const MAX_LINES = 7         // max visible lines in body container
const CJK_RATIO = 52 / 28  // CJK char width relative to ASCII (~1.857)

/** Returns the display width of a single character in half-width units */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // CJK Unified Ideographs, Hiragana, Katakana, Fullwidth forms, CJK Symbols
  if (
    (code >= 0x3000 && code <= 0x9FFF) ||   // CJK, Hiragana, Katakana, symbols
    (code >= 0xF900 && code <= 0xFAFF) ||   // CJK Compatibility
    (code >= 0xFF01 && code <= 0xFF60) ||   // Fullwidth Latin
    (code >= 0xFFE0 && code <= 0xFFE6) ||   // Fullwidth symbols
    (code >= 0x20000 && code <= 0x2FA1F)    // CJK Extension B+
  ) {
    return CJK_RATIO
  }
  return 1
}

/** Total display width of a string, in the same half-width units as the panel. */
function displayWidth(text: string): number {
  let w = 0
  for (let i = 0; i < text.length; i++) w += charWidth(text[i])
  return w
}

/** 行頭禁則: characters that must not open a line. A lone `。` pushed onto the
 *  next line is the most visible artefact of a naive 52-column split. */
const NO_LINE_START = '。、．，・：；！？!?)）］」』｝》〉”’…ー〜%％'

/** 行末禁則: opening brackets must not be left dangling at the end of a line. */
const NO_LINE_END = '（(［[「『｛{《〈“‘'

/** Columns we are willing to leave blank to keep an ASCII word whole. Beyond
 *  this the ragged margin costs more than the broken word — with only seven
 *  lines on screen, half a blank line is not worth an unbroken identifier. */
const MAX_WORD_CARRY = 12

const WORD_CHAR = /[A-Za-z0-9'._-]/

/**
 * Decide where to actually cut a full line, given the character at `i` that no
 * longer fits. Returns [keep, carry]: `keep` closes the line, `carry` moves
 * down ahead of that character.
 *
 * All three rules push characters down rather than letting them overflow — the
 * column widths here are measured approximations, so an overflowing line would
 * be re-wrapped by the G2's own container and land right back on the artefact
 * we are avoiding.
 */
function chooseBreak(line: string, text: string, i: number): [string, string] {
  const next = text[i]

  if (NO_LINE_START.includes(next)) {
    // Carry at most two characters, or a run of closers would empty the line.
    for (let n = 1; n <= 2 && n < line.length; n++) {
      const cut = line.length - n
      if (!NO_LINE_START.includes(line[cut]) && line[cut] !== ' ') {
        return [line.slice(0, cut), line.slice(cut)]
      }
    }
    return [line, '']
  }

  if (line.length > 1 && NO_LINE_END.includes(line[line.length - 1])) {
    return [line.slice(0, -1), line.slice(-1)]
  }

  if (/[A-Za-z0-9]/.test(next)) {
    let start = line.length
    while (start > 0 && WORD_CHAR.test(line[start - 1])) start--
    const carried = line.length - start
    if (start === 0 || carried === 0 || carried > MAX_WORD_CARRY) return [line, '']
    // Only worth a ragged margin if the word then fits whole. A URL or a very
    // long path is going to be split wherever it lands, so leave the blank
    // columns out of it.
    let end = i
    while (end < text.length && WORD_CHAR.test(text[end])) end++
    if (carried + (end - i) > LINE_WIDTH) return [line, '']
    return [line.slice(0, start).trimEnd(), line.slice(start)]
  }

  return [line, '']
}

/** Split text into display lines respecting character widths and newlines */
function splitDisplayLines(text: string): string[] {
  const lines: string[] = []
  let currentLine = ''
  let currentWidth = 0
  // True while the line was opened by a wrap rather than by a newline, so the
  // space the wrap fell on can be dropped without eating real indentation.
  let wrapped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') {
      lines.push(currentLine)
      currentLine = ''
      currentWidth = 0
      wrapped = false
      continue
    }
    // The space between two words is where the break happened — carrying it to
    // the next line leaves a stray indent, which on the panel reads as an
    // unexplained gap in the middle of a sentence.
    if (wrapped && !currentLine && ch === ' ') continue
    const w = charWidth(ch)
    if (currentWidth + w > LINE_WIDTH && currentLine) {
      const [keep, carry] = chooseBreak(currentLine, text, i)
      lines.push(keep.trimEnd())
      currentLine = carry
      currentWidth = displayWidth(carry)
      wrapped = true
      i-- // re-examine ch against the fresh line
      continue
    }
    currentLine += ch
    currentWidth += w
  }
  if (currentLine) lines.push(currentLine.trimEnd())
  return lines
}

/** Paginate a single message by display lines */
function paginateSingleMessage(fullText: string, page: number): { text: string; pageInfo: string; totalPages: number } {
  const allLines = splitDisplayLines(fullText)

  if (allLines.length <= MAX_LINES) {
    return { text: fullText, pageInfo: '', totalPages: 1 }
  }

  const overlap = 1
  const advance = MAX_LINES - overlap
  const totalPages = Math.ceil((allLines.length - MAX_LINES) / advance) + 1
  const p = Math.min(page, totalPages - 1)
  const start = p * advance
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
 * Padded to the body's 52 columns rather than the 53 the header's own 4px
 * padding allows: the browser simulator measures CJK a little wider than the
 * device does, and a column of slack costs nothing visible while an overflow
 * would wrap the clock out of a 36px-tall container. A long title is clipped
 * rather than pushing the clock off — the time is the part that has to stay
 * put to be readable at a glance.
 *
 * No timer drives this: the server pushes `sessions-updated` every five
 * seconds and each push re-renders, so the minute is never stale.
 */
function withClock(title: string): string {
  const now = new Date()
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const room = LINE_WIDTH - displayWidth(clock) - 1 // keep at least one space
  let head = title
  while (head && displayWidth(head) > room) head = head.slice(0, -1)
  // Floor, not round: a CJK title measures fractionally, and rounding the gap
  // up put the header a third of a column past the edge.
  const gap = Math.max(1, Math.floor(LINE_WIDTH - displayWidth(head) - displayWidth(clock)))
  return `${head}${' '.repeat(gap)}${clock}`
}

function isWaiting(s: Session): boolean {
  return s.indicatorState === 'waiting_input' || (!!s.waitingToolName && s.waitingToolName !== 'UserInput')
}

function statusLabel(s: Session): string {
  if (isWaiting(s)) return '[!]'
  if (s.indicatorState === 'processing') return '[*]'
  return ''
}

const SEPARATOR = '-'.repeat(24)

/** Trim a line down until an appended ellipsis still fits the panel. */
function ellipsize(line: string): string {
  let out = line
  while (out && displayWidth(out) + 1 > LINE_WIDTH) out = out.slice(0, -1)
  return `${out}…`
}

/**
 * The recap block, capped in *display* lines.
 *
 * `recapBlockLines` counts logical lines, so a recap that arrives as one long
 * sentence — the usual shape — passed the cap untouched and then wrapped to
 * five or six rows, crowding out the conversation it was meant to introduce.
 */
function recapBlock(recap: string | undefined, maxLines = 2): string[] {
  const block = recapBlockLines(recap, maxLines)
  if (!block.length) return []
  const body = block.slice(0, -1).flatMap(splitDisplayLines)
  const separator = block[block.length - 1]
  if (body.length <= maxLines) return [...body, separator]
  return [...body.slice(0, maxLines - 1), ellipsize(body[maxLines - 1]), separator]
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
    const choiceHint = top.choices?.length ? `(選択${top.choices.length})` : ''
    const more = state.relayWaiting.length > 1 ? ` 他${state.relayWaiting.length - 1}件` : ''
    const head = splitDisplayLines(`[!]${relayLabel(state, top)}${choiceHint}${more}`)[0] || ''
    const textLines = splitDisplayLines(top.text).slice(0, 2)
    return [head, ...textLines, SEPARATOR]
  }
  const info = state.relayInfo[0]
  if (info) {
    const textLine = splitDisplayLines(info.text)[0] || ''
    return [splitDisplayLines(`[i]${relayLabel(state, info)}: ${textLine}`)[0] || '', SEPARATOR]
  }
  return []
}

// ─── Content helpers (shared by build and in-place update) ───

function sessionListHeader(state: AppState): string {
  const { sessionIndex, sessions, relayWaiting } = state
  const badge = relayWaiting.length > 0 ? ` !${relayWaiting.length}` : ''
  return withClock(`CC Hub ${sessionIndex + 1}/${sessions.length}${badge}`)
}

function sessionListBody(state: AppState): string {
  const { sessions, sessionIndex } = state
  // Relay waiting covers agent-declared items whose session indicator is not
  // waiting_input; those sessions still get the [!] marker.
  const relayWaitingIds = new Set(state.relayWaiting.map((i) => i.sessionId))
  const start = Math.max(0, sessionIndex - 3)
  const visible = sessions.slice(start, start + MAX_LINES)
  return visible.map((s, i) => {
    const idx = start + i
    const cursor = idx === sessionIndex ? '>' : ' '
    const label = relayWaitingIds.has(s.id) ? '[!]' : statusLabel(s)
    // Pad the badge so every name starts in the same column: a list where
    // `>[!] name` and `  name` begin three columns apart is hard to scan.
    return `${cursor}${label.padEnd(3)} ${sName(s)}`
  }).join('\n') || '(no sessions)'
}

function conversationContent(state: AppState): { headerText: string; bodyText: string; footerText: string; multiCount: number } {
  const session = state.sessions[state.sessionIndex]
  const waiting = session ? isWaiting(session) : false
  const ind = session?.indicatorState
  const statusBadge = waiting ? '  [!] WAITING' : ind === 'processing' ? '  [*]' : ''

  const msgs = state.conversation
  const msgIndex = msgs.length > 0
    ? Math.max(0, msgs.length - 1 - state.conversationOffset)
    : -1
  const { text: convText, pageInfo, multiCount } = paginateMessage(msgs, msgIndex, state.conversationPage)
  const banner = relayBannerLines(state)
  // Recap heads the latest view; deeper paging drops it for message space.
  const onLatest = state.conversationOffset === 0 && state.conversationPage === 0
  const recap = onLatest ? recapBlock(session?.ccRecap) : []
  // The body container clips overflow: cap the banner+recap+content block at
  // one page so a waiting overlay never pushes conversation text off-screen.
  // Everything is measured in display lines — counting the conversation in
  // logical lines let a wrapped paragraph run off the bottom unnoticed.
  const content = convText.split('\n').flatMap(splitDisplayLines)
  const bodyText = [...banner, ...recap, ...content].slice(0, MAX_LINES).join('\n')
  const role = multiCount > 1
    ? `${multiCount}msgs`
    : msgIndex >= 0 ? (msgs[msgIndex].role === 'user' ? 'YOU' : 'AI') : ''
  const pos = msgs.length > 0 ? `${role} ${msgIndex + 1}/${msgs.length}${pageInfo}` : ''
  // With a waiting banner up, the ring is routed to the overlay item:
  // tap = respond/jump, double-tap = dismiss ("later / on PC").
  const action = state.relayWaiting.length > 0 ? 'tap:対応  dbl:後で' : waiting ? 'tap:respond  dbl:back' : 'dbl:back'

  return {
    headerText: withClock(`${session ? sName(session) : '---'}${statusBadge}`),
    bodyText,
    footerText: `${action}  ${pos}`,
    multiCount,
  }
}

// Footers that are fixed per mode (the rest are built with their content).
// Named so the browser simulator renders the same string the G2 does instead
// of a hand-copied approximation.
const FOOTER_SESSION_LIST = 'tap:open  swipe:nav'
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

/**
 * The three container strings the G2 is about to render, for one mode.
 *
 * This is the seam the browser simulator renders through, so what it shows is
 * the device's own output — same wrapping at 52 columns, same 7-line clamp,
 * same pagination — rather than a second implementation that silently drifts.
 */
export function screenText(state: AppState): { header: string; body: string; footer: string } {
  switch (state.mode) {
    case 'session_list':
      return {
        header: sessionListHeader(state),
        body: sessionListBody(state),
        footer: FOOTER_SESSION_LIST,
      }
    case 'conversation': {
      const { headerText, bodyText, footerText } = conversationContent(state)
      return { header: headerText, body: bodyText, footer: footerText }
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

/** Full-screen presentation of one waiting relay item (#504). Swipe cycles the
 *  waiting queue, tap jumps to the item's session, double-tap dismisses. */
function overlayContent(state: AppState): { headerText: string; bodyText: string; footerText: string } {
  const waiting = state.relayWaiting
  const item = waiting.find((i) => i.id === state.overlayItemId) || waiting[0]
  if (!item) {
    return { headerText: withClock('Relay'), bodyText: '(waiting なし)', footerText: 'dbl:戻る' }
  }
  const idx = waiting.indexOf(item)
  const headerText = withClock(`${relayLabel(state, item)} [!] ${idx + 1}/${waiting.length}`)

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
  const footerText = item.choices?.length
    ? 'tap:選択へ  dbl:後で  swipe:次'
    : 'tap:開く  dbl:後で  swipe:次'
  return { headerText, bodyText, footerText }
}

function voiceContent(state: AppState): { headerText: string; bodyText: string; footerText: string } {
  const session = state.sessions[state.sessionIndex]
  const name = state.voiceSessionName || (session ? sName(session) : '---')
  switch (state.voicePhase) {
    case 'recording':
      return {
        headerText: withClock(`${name}  [録音中]`),
        bodyText: '● 録音中\n\nマイクに向かって話してください',
        footerText: 'tap:停止して認識  dbl:キャンセル',
      }
    case 'transcribing':
      return {
        headerText: withClock(`${name}  [認識中]`),
        bodyText: '認識中…',
        footerText: 'dbl:キャンセル',
      }
    default: // 'confirm'
      return {
        headerText: withClock(`${name}  [確認]`),
        bodyText: state.voiceText ? state.voiceText : '(認識できませんでした)',
        footerText: state.voiceText ? 'tap:送信  dbl:キャンセル' : 'dbl:戻る',
      }
  }
}

// ─── Page builders ───

function buildSessionList(state: AppState): RebuildPageContainer {
  const headerText = sessionListHeader(state)
  const listText = sessionListBody(state)

  const header = new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 1, containerName: 'header',
    isEventCapture: 0,
    content: headerText,
  })

  const list = new TextContainerProperty({
    xPosition: 4, yPosition: 36,
    width: W - 8, height: H - 36 - 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 2, containerName: 'list',
    isEventCapture: 0,
    content: listText,
  })

  // Footer - minimal
  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: H - 36,
    width: W, height: 36,
    borderWidth: 0,
    paddingLength: 4,
    containerID: 3, containerName: 'footer',
    isEventCapture: 1,
    content: FOOTER_SESSION_LIST,
  })

  return new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [header, list, footer],
  })
}

function buildConversation(state: AppState): RebuildPageContainer {
  const { headerText, bodyText, footerText } = conversationContent(state)

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
    paddingLength: 8,
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
    content: 'CC Hub Glasses',
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
    content: 'CC Hub未接続\n\nスマホのEven Hubアプリからこのアプリを開いてCC HubのURLを設定してください\n\n1. PCでCC Hubを起動\n2. スマホのアプリ画面でURL入力\n3. メガネから再度起動',
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

let currentMode: Mode | null = null

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
          content: 'CC Hub Glasses\nConnecting...',
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

    await Promise.race([
      bridge.createStartUpPageContainer(initial),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('createStartUp timeout')), 3000)),
    ])
    return bridge
  } catch (e) {
    console.log('[display] Even Hub SDK not available — debug mode', e)
    return null
  }
}

export async function updateDisplay(bridge: Bridge | null, state: AppState): Promise<void> {
  if (!bridge) return

  const needsRebuild = state.mode !== currentMode
  currentMode = state.mode

  if (needsRebuild) {
    let container: RebuildPageContainer
    switch (state.mode) {
      case 'session_list': container = buildSessionList(state); break
      case 'conversation': container = buildConversation(state); break
      case 'choice': container = buildChoice(state); break
      case 'voice': container = buildVoice(state); break
      case 'overlay': container = buildOverlay(state); break
    }
    await bridge.rebuildPageContainer(container)
    return
  }

  // In-place text updates
  switch (state.mode) {
    case 'session_list': {
      await Promise.all([
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 1, containerName: 'header',
          content: sessionListHeader(state),
        })),
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 2, containerName: 'list',
          content: sessionListBody(state),
        })),
      ])
      break
    }
    case 'conversation': {
      const { headerText, bodyText, footerText } = conversationContent(state)
      await Promise.all([
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 1, containerName: 'header',
          content: headerText,
        })),
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 2, containerName: 'body',
          content: bodyText,
        })),
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 3, containerName: 'footer',
          content: footerText,
        })),
      ])
      break
    }
    case 'choice': {
      await Promise.all([
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 1, containerName: 'header',
          content: choiceHeader(state),
        })),
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 2, containerName: 'body',
          content: choiceBody(state),
        })),
      ])
      break
    }
    case 'voice': {
      const { headerText, bodyText, footerText } = voiceContent(state)
      await Promise.all([
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 1, containerName: 'header',
          content: headerText,
        })),
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 2, containerName: 'body',
          content: bodyText,
        })),
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 3, containerName: 'footer',
          content: footerText,
        })),
      ])
      break
    }
    case 'overlay': {
      const { headerText, bodyText, footerText } = overlayContent(state)
      await Promise.all([
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 1, containerName: 'header',
          content: headerText,
        })),
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 2, containerName: 'body',
          content: bodyText,
        })),
        bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 3, containerName: 'footer',
          content: footerText,
        })),
      ])
      break
    }
  }
}

// ─── Events ───

export function setupEvents(
  bridge: Bridge | null,
  callbacks: {
    onSwipeDown: () => void
    onSwipeUp: () => void
    onTap: () => void
    onDoubleTap: () => void
    onRawEvent?: (raw: string) => void
    onAudioData?: (pcm: Uint8Array) => void
  },
): void {
  if (!bridge) return
  let lastEventTime = 0
  const EVENT_DEBOUNCE = 300

  bridge.onEvenHubEvent((event) => {
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
