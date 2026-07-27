import { getTextWidth } from '@evenrealities/pretext'

/**
 * How the G2 panel measures text.
 *
 * The firmware renders with LVGL and a proportional font: a space is 5px, `i`
 * is 4, `W` is 16, CJK is 20. Everything here used to be counted in "columns"
 * of a notional 52-per-line monospace grid, which was close enough on average
 * to look right and wrong enough that a right-aligned clock landed near the
 * middle of the panel. `@evenrealities/pretext` embeds the firmware's own font
 * metrics — same kerning, same per-glyph rounding — so widths are exact and
 * the guessing stops.
 */

export { getTextWidth as textWidth }

// ─── Container geometry ───
//
// Inner content width is `width - 2 * (paddingLength + borderWidth)`; the
// containers below carry no border. LVGL gives every line 27px and no
// fraction of one, so a container's line capacity is a floor division.

export const PANEL_W = 576
export const PANEL_H = 288
/** Header and footer container height. */
export const BAR_H = 36
/** LVGL's fixed line height. */
export const LINE_H = 27

const HEADER_PAD = 4
const BODY_PAD = 6

/** Usable width of the header (and footer) container. Holds exactly one line:
 *  28px of inner height against a 27px line, so anything that wraps is gone. */
export const HEADER_WIDTH = PANEL_W - 2 * HEADER_PAD

/** Usable width of the body container. */
export const BODY_WIDTH = PANEL_W - 8 - 2 * BODY_PAD

/** Lines the body container shows before clipping. */
export const MAX_LINES = Math.floor((PANEL_H - 2 * BAR_H - 2 * BODY_PAD) / LINE_H)

export const SPACE_W = getTextWidth(' ')

// ─── Measuring ───

/** The last code point of a string, kept whole so a surrogate pair is not cut. */
function lastCodePoint(s: string): string {
  if (!s) return ''
  const tail = s.charCodeAt(s.length - 1)
  return tail >= 0xdc00 && tail <= 0xdfff && s.length >= 2 ? s.slice(-2) : s.slice(-1)
}

/**
 * Width `ch` adds when it follows `prev`, kerning included.
 *
 * Summing these deltas character by character reproduces `textWidth` of the
 * whole string exactly (verified against kerning-heavy samples), which is what
 * lets the line breaker below run in one pass instead of re-measuring a
 * growing prefix.
 */
export function advance(prev: string, ch: string): number {
  return getTextWidth(prev + ch) - getTextWidth(prev)
}

/**
 * Clip to a pixel budget, with the ellipsis inside it.
 *
 * Appending the ellipsis after the fit check put the result over budget, so
 * the "clipped" string wrapped anyway and left a stub on a line of its own.
 */
export function clipToWidth(text: string, maxPx: number): string {
  const ellipsis = '…'
  let width = 0
  let fits = 0 // longest prefix that still leaves room for the ellipsis
  let prev = ''
  for (const ch of text) {
    const w = advance(prev, ch)
    if (width + w + getTextWidth(ellipsis) <= maxPx) fits += ch.length
    width += w
    if (width > maxPx) return `${text.slice(0, fits)}${ellipsis}`
    prev = ch
  }
  return text
}

// ─── Line breaking ───

/** 行頭禁則: characters that must not open a line. A lone `。` pushed onto the
 *  next line is the most visible artefact of a naive wrap. */
const NO_LINE_START = '。、．，・：；！？!?)）］」』｝》〉”’…ー〜%％'

/** 行末禁則: opening brackets must not be left dangling at the end of a line. */
const NO_LINE_END = '（(［[「『｛{《〈“‘'

/** Blank space we will leave to keep an ASCII word whole. Beyond this the
 *  ragged margin costs more than the broken word — with seven lines on screen,
 *  a fifth of one is not worth an unbroken identifier. */
const MAX_WORD_CARRY = 110

const WORD_CHAR = /[A-Za-z0-9'._-]/

/**
 * Decide where to actually cut a full line, given the character that no longer
 * fits. Returns [keep, carry]: `keep` closes the line, `carry` moves down
 * ahead of that character.
 *
 * All three rules push characters down rather than letting them overflow.
 * Overflow is never an option: the firmware would wrap the line itself, right
 * back into the artefact being avoided.
 */
function chooseBreak(line: string, next: string, rest: string, maxPx: number): [string, string] {
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
    if (start === 0 || start === line.length) return [line, '']
    const carried = line.slice(start)
    const carriedPx = getTextWidth(carried)
    if (carriedPx > MAX_WORD_CARRY) return [line, '']
    // Only worth a ragged margin if the word then fits whole. A URL or a long
    // path is going to be split wherever it lands, so leave the blank pixels
    // out of it.
    let end = 0
    while (end < rest.length && WORD_CHAR.test(rest[end])) end++
    if (carriedPx + getTextWidth(rest.slice(0, end)) > maxPx) return [line, '']
    return [line.slice(0, start).trimEnd(), carried]
  }

  return [line, '']
}

/** Break text into the lines the panel will show, at a pixel width. */
export function splitLines(text: string, maxPx: number = BODY_WIDTH): string[] {
  const lines: string[] = []
  let line = ''
  let width = 0
  // True while the line was opened by a wrap rather than by a newline, so the
  // space the wrap fell on can be dropped without eating real indentation.
  let wrapped = false

  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number)
    if (ch === '\n') {
      lines.push(line)
      line = ''
      width = 0
      wrapped = false
      i += ch.length
      continue
    }
    // The space between two words is where the break happened — carrying it to
    // the next line leaves a stray indent, which reads as an unexplained gap
    // in the middle of a sentence.
    if (wrapped && !line && ch === ' ') {
      i += ch.length
      continue
    }
    const w = advance(lastCodePoint(line), ch)
    if (width + w > maxPx && line) {
      const [keep, carry] = chooseBreak(line, ch, text.slice(i + ch.length), maxPx)
      lines.push(keep.trimEnd())
      line = carry
      width = getTextWidth(carry)
      wrapped = true
      continue // re-examine ch against the fresh line
    }
    line += ch
    width += w
    i += ch.length
  }
  if (line) lines.push(line.trimEnd())
  return lines
}

/** Trim a line until an appended ellipsis fits the given width. */
export function ellipsize(line: string, maxPx: number = BODY_WIDTH): string {
  let out = line
  while (out && getTextWidth(out) + getTextWidth('…') > maxPx) out = out.slice(0, -1)
  return `${out}…`
}
