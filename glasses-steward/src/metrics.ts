import { getAdvW, getTextWidth } from '@evenrealities/pretext'

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
/**
 * Header and footer container height.
 *
 * 32 rather than 36. The bar holds exactly one line either way - its inner
 * height is `BAR_H - 2 * HEADER_PAD`, which stays at 28 against a 27px line -
 * so the four pixels came out of padding that was doing nothing but sitting
 * there. Two bars' worth, plus a tighter `BODY_PAD`, is what buys the
 * conversation its eighth line: the band was 204px usable, which is seven rows
 * and 15px of remainder.
 */
export const BAR_H = 32
/** LVGL's fixed line height. */
export const LINE_H = 27

/** Inset inside the header and footer bars. Exported because the simulator's
 *  painter draws to the same baselines and used to keep its own copy. */
export const HEADER_PAD = 2
/** Inset inside the body container. Exported for the same reason. */
export const BODY_PAD = 2

/** Usable width of the header (and footer) container. Holds exactly one line:
 *  28px of inner height against a 27px line, so anything that wraps is gone. */
export const HEADER_WIDTH = PANEL_W - 2 * HEADER_PAD

/** Usable width of the body container. */
export const BODY_WIDTH = PANEL_W - 8 - 2 * BODY_PAD

/** Lines the body container shows before clipping. */
export const MAX_LINES = Math.floor((PANEL_H - 2 * BAR_H - 2 * BODY_PAD) / LINE_H)

/**
 * The list's own padding, tighter than `BODY_PAD`.
 *
 * At 6 the container had 240px for rows of 27, which is 8 rows and 24px of
 * remainder — a gap above the footer wide enough to be asked about, holding a
 * row that would not fit by 3px. At 2 there are 248px, so the ninth row fits
 * with 5px to spare. The horizontal padding goes with it (the container is
 * already inset 4px from the panel edge, so text still clears it).
 */
export const LIST_PAD = 2

/**
 * Lines the list gets, which is two more than the body.
 *
 * The list screen carries no header: a title bar over a list of titles is a
 * line spent saying nothing, and the counter and clock it held fit in the
 * footer beside the gestures. Giving the container that 36px back buys a
 * whole row — which is exactly what a list that now includes panes needs.
 * `LIST_PAD` buys the next one.
 */
export const LIST_LINES = Math.floor((PANEL_H - BAR_H - 2 * LIST_PAD) / LINE_H)

// ─── The notification card ───
//
// A notification used to be drawn the way every other screen is: a header, the
// panel filled with text, a footer. Which is why it was missed - nothing about
// it said "this arrived", only "you are looking at something else now". A
// wearer glancing up saw a screen, not an interruption.
//
// So it is inset from the panel edge and given a border. The margin is the
// half of it that matters: a box drawn edge to edge is just a line around the
// screen, while a box with the panel showing on all four sides reads as
// something laid on top. It costs a line of text, which a notification can
// afford and a conversation could not.

/** How far the card sits in from the panel's left and right edges. */
export const CARD_INSET_X = 36
/** How far it sits below the header and above the footer. */
export const CARD_INSET_Y = 12
export const CARD_BORDER = 2
/** Rounded, because nothing else on this panel is: the corner alone says the
 *  box is not part of the layout underneath it. */
export const CARD_RADIUS = 8
/** 0-15 on this panel's 16 greens. Brighter than the notice strip's rule -
 *  that one separates, this one has to be noticed. */
export const CARD_BORDER_COLOR = 12

export const CARD_X = CARD_INSET_X
export const CARD_W = PANEL_W - 2 * CARD_INSET_X

/** Usable width inside the card, once its border and padding are taken. */
export const CARD_WIDTH = CARD_W - 2 * BODY_PAD - 2 * CARD_BORDER
/** The tallest it may grow - one line fewer than the body it replaces, which is
 *  the price of the frame. */
export const CARD_LINES = Math.floor(
  (PANEL_H - 2 * BAR_H - 2 * CARD_INSET_Y - 2 * BODY_PAD - 2 * CARD_BORDER) / LINE_H,
)

/**
 * Where the card sits, for a message of `lines` lines.
 *
 * Sized to its content and centred, rather than filling the band between the
 * bars. A box the height of the screen with three lines in it is a page with a
 * line drawn round it; a box the height of its message is a message. Empty
 * panel above and below is what makes it read as something laid on top.
 *
 * The height is container geometry on the device, so anything that changes the
 * line count has to rebuild the page rather than upgrade the text in place -
 * the same rule the notice strip follows.
 */
export function cardBox(lines: number): { x: number; y: number; w: number; h: number } {
  const n = Math.max(1, Math.min(lines, CARD_LINES))
  const h = n * LINE_H + 2 * BODY_PAD + 2 * CARD_BORDER
  const band = PANEL_H - 2 * BAR_H
  return { x: CARD_X, y: BAR_H + Math.round((band - h) / 2), w: CARD_W, h }
}

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

// ─── Glyph coverage ───

const PICTOGRAPH = /\p{Extended_Pictographic}/u

/**
 * Marks the panel cannot draw, rewritten as ones it can.
 *
 * The firmware carries the CJK symbol set — ○ × △ ！ ※ ★ all have real
 * advances — and in a Japanese context those *are* the conventional marks for
 * good, bad, partial and attention. So a status emoji does not have to be
 * thrown away; it has an equivalent that says the same thing in the same
 * column. Only glyphs with a genuine counterpart are here. Decoration (🎉, 🚀)
 * has nothing to become and still goes.
 */
const SUBSTITUTES = new Map<string, string>([
  // done / good
  ...['✅', '✔', '✓', '☑', '🟢', '🆗', '👍', '⭕'].map((c) => [c, '○'] as const),
  // failed / bad
  ...['❌', '✗', '✘', '☒', '✕', '🔴', '🚫', '⛔', '👎'].map((c) => [c, '×'] as const),
  // attention
  ...['⚠', '❗', '❕', '‼', '🚨'].map((c) => [c, '！'] as const),
  ...['❓', '❔'].map((c) => [c, '？'] as const),
  // emphasis
  ...['⭐', '🌟', '✨'].map((c) => [c, '★'] as const),
  // note
  ...['💡', 'ℹ', '📌', '📝'].map((c) => [c, '※'] as const),
  // direction
  ...['➡', '▶', '▷'].map((c) => [c, '→'] as const),
  ...['⬅', '◀', '◁'].map((c) => [c, '←'] as const),
  ...['⬆', '🔼'].map((c) => [c, '↑'] as const),
  ...['⬇', '🔽'].map((c) => [c, '↓'] as const),
  ...['🔺'].map((c) => [c, '▲'] as const),
  ...['🔻'].map((c) => [c, '▼'] as const),
  // Status dots keep their three states: a green and a yellow light both
  // becoming ○ would lose the distinction they exist to make.
  ...['⚪'].map((c) => [c, '○'] as const),
  ...['🟡', '🟠'].map((c) => [c, '△'] as const),
  ...['🔵', '🟣', '🟤', '⚫'].map((c) => [c, '●'] as const),
])

/**
 * Drop what the panel has no glyph for.
 *
 * Two rules, because neither alone is enough. `getAdvW` returns 0 for a
 * codepoint the firmware fonts do not carry, which catches ✓, ✗, ⚠ and most
 * emoji. It does not catch ✅: pretext measures that one at 320px from an
 * emoji font this device turns out not to have, and the panel draws tofu. So
 * pictographs go regardless of what they measure.
 *
 * Sent anyway they cost a column and say nothing. Dropping them here also
 * keeps the browser simulator honest — it would otherwise render an emoji
 * beautifully that the wearer never sees.
 */
export function stripUnrenderable(text: string): string {
  let out = ''
  let dropped = false
  for (const ch of text) {
    if (ch === '\n') {
      out += ch
      continue
    }
    const cp = ch.codePointAt(0) as number
    // Selectors and joiners only qualify the glyph beside them; alone they are
    // leftovers from an emoji that has already gone.
    const isModifier = cp === 0xfe0f || cp === 0x200d || (cp >= 0x1f3fb && cp <= 0x1f3ff)
    if (isModifier) continue
    const swap = SUBSTITUTES.get(ch)
    if (swap) {
      // Substituted, not dropped: nothing was left behind, so the spacing
      // around it is still the author's.
      out += swap
      continue
    }
    if (PICTOGRAPH.test(ch) || getAdvW(cp) === 0) {
      dropped = true
      continue
    }
    out += ch
  }
  // A dropped glyph leaves the spaces that flanked it behind: two in the middle
  // of a line read as a gap rather than a word break, and one at the start as
  // an indent that was never written. Only touched when something went, so a
  // line nobody edited keeps its own spacing.
  if (!dropped) return out
  return out
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
}

// ─── Line breaking ───

/** Kinsoku (line-start): characters that must not open a line. A lone `.` pushed onto the
 *  next line is the most visible artefact of a naive wrap. */
const NO_LINE_START = '。、．，・：；！？!?)）］」』｝》〉”’…ー〜%％'

/** Kinsoku (line-end): opening brackets must not be left dangling at the end of a line. */
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
