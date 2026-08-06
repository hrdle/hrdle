/**
 * Options an agent draws as one horizontal row, read from their colours.
 *
 * OpenCode's permission prompt is the case this exists for:
 *
 * ```
 *    Allow once   Allow always   Reject
 *   ctrl+f fullscreen  ⇆ select  enter confirm
 * ```
 *
 * Neither `extractChoices` shape fits it - there is no numbering and there are
 * no checkboxes - and the two rows are indistinguishable as text: both are
 * short phrases separated by runs of spaces, so any rule that admitted the
 * first would admit the second and offer a wearer `ctrl+f fullscreen` as an
 * answer.
 *
 * They are not indistinguishable as *pixels*. Measured against a live pane:
 * the selected option is drawn on its own background (`48;2;245;167;66`) while
 * its siblings sit on the row's (`48;2;30;30;30`), and every item in the footer
 * shares one background - the keys differ only in foreground. So "exactly one
 * item painted differently from the rest" both finds the menu and rejects the
 * footer, and it does it without knowing a word of what either says.
 *
 * That colour is also the only place the *current* selection exists. OpenCode
 * gives its options no keys of their own - `⇆ select`, `enter confirm` - so
 * answering means moving its cursor, and 0.0.52 removed exactly that for
 * driving a second cursor blind and watching the two drift apart. Reading the
 * highlight on every pass is what makes moving it safe again: the position is
 * measured rather than assumed, so a redraw cannot put the two out of step.
 *
 * This needs the escape sequences intact, so it runs before `stripAnsi` rather
 * than after it, unlike everything else that reads a pane here.
 */

/** A row of options drawn side by side, and which one the pane has selected. */
export interface InlineChoices {
  options: string[]
  /** Index into `options` of the item the pane has highlighted. */
  selected: number
}

/** How far back from the tail a row of options may sit. Matches the numbered
 *  and checkbox readers: a prompt lives at the bottom of a pane. */
const INLINE_TAIL_LINES = 25

/** Spaces that separate one option from the next. Two is the narrowest gap
 *  observed between items; a single space occurs *inside* one (`Allow once`). */
const ITEM_GAP = 2

/** Longest an option may be. A sentence on a row of buttons is prose that
 *  happened to be painted, not a menu. */
const MAX_ITEM_CHARS = 40

const SGR = /\x1b\[([0-9;]*)m/g

/**
 * Split a line into its visible characters, each carrying the background it is
 * painted on. Only the background is tracked: the foreground varies within a
 * single item (OpenCode's footer writes the key brighter than its label), so
 * it separates things that belong together.
 *
 * `null` is the terminal's default background.
 */
export function paintedChars(line: string): Array<{ ch: string; bg: string | null }> {
  const out: Array<{ ch: string; bg: string | null }> = []
  let bg: string | null = null
  let at = 0
  SGR.lastIndex = 0
  for (let m = SGR.exec(line); m; m = SGR.exec(line)) {
    for (const ch of line.slice(at, m.index)) out.push({ ch, bg })
    bg = backgroundAfter(bg, m[1])
    at = m.index + m[0].length
  }
  for (const ch of line.slice(at)) out.push({ ch, bg })
  return out
}

/** The background a run of SGR parameters leaves in effect. */
function backgroundAfter(current: string | null, params: string): string | null {
  // An empty parameter list is `ESC[m`, which means reset.
  const codes = (params === '' ? '0' : params).split(';')
  let bg = current
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code === '0') bg = null
    else if (code === '49') bg = null
    else if (code === '48') {
      // Truecolor `48;2;r;g;b` and 256-colour `48;5;n`, both consumed whole so
      // their arguments are not mistaken for further codes.
      if (codes[i + 1] === '2') { bg = codes.slice(i + 2, i + 5).join(';'); i += 4 }
      else if (codes[i + 1] === '5') { bg = `i${codes[i + 2]}`; i += 2 }
    } else if (/^(4[0-7]|10[0-7])$/.test(code)) bg = code
  }
  return bg
}

interface Item {
  text: string
  bg: string | null
}

/** Split one painted line into the items a run of spaces separates. */
function itemsOf(cells: Array<{ ch: string; bg: string | null }>): Item[] {
  const items: Item[] = []
  let run: Array<{ ch: string; bg: string | null }> = []
  let gap = 0

  const flush = () => {
    const text = run.map((c) => c.ch).join('').trim()
    if (text) {
      // The background of the item's own characters, not of the spaces around
      // it: a highlight is padded with spaces that carry it, and a plain item
      // is surrounded by spaces that do not.
      const painted = run.filter((c) => c.ch.trim())
      items.push({ text, bg: painted[0]?.bg ?? null })
    }
    run = []
  }

  for (const cell of cells) {
    if (cell.ch === ' ') {
      gap++
      if (gap >= ITEM_GAP) flush()
      else if (run.length) run.push(cell)
      continue
    }
    gap = 0
    run.push(cell)
  }
  flush()
  return items
}

/**
 * The colour the row itself is painted, read from its spaces.
 *
 * A terminal pads every line out to the width of the pane, so the spaces are
 * the largest sample of the row's own background there is - and unlike the
 * items, they are never the thing being highlighted, except for the one or two
 * that pad a highlight from the inside.
 *
 * Undefined when the row has no spaces to judge by, which a row of options
 * never is: they are separated by them.
 */
function dominantSpaceBackground(cells: Array<{ ch: string; bg: string | null }>): string | undefined {
  const counts = new Map<string, number>()
  for (const cell of cells) {
    if (cell.ch !== ' ') continue
    const key = String(cell.bg)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [bg, n] of counts) {
    if (n > bestCount) { best = bg; bestCount = n }
  }
  return best
}

/** A gutter or rule rather than an option: the box-drawing a pane frames with. */
function isFurniture(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}

/**
 * The row of side-by-side options a pane is offering, or nothing.
 *
 * Give it the pane's lines **with their escape sequences intact**. The newest
 * qualifying row wins: a pane redraws its prompt in place, and what is lowest
 * on the screen is what is being asked now.
 */
export function extractInlineChoices(lines: string[]): InlineChoices | undefined {
  const from = Math.max(0, lines.length - INLINE_TAIL_LINES)
  for (let i = lines.length - 1; i >= from; i--) {
    const found = inlineChoicesInRow(lines[i] ?? '')
    if (found) return found
  }
  return undefined
}

/** The same read, for a single row. Exported for the tests. */
export function inlineChoicesInRow(line: string): InlineChoices | undefined {
  const cells = paintedChars(line)
  const items = itemsOf(cells).filter((it) => !isFurniture(it.text))
  if (items.length < 2) return undefined
  if (items.some((it) => it.text.length > MAX_ITEM_CHARS)) return undefined

  // Exactly one item painted unlike the row it sits on. This is what separates
  // the menu from the key hints under it, where every item shares the row's own
  // background, and it names the selection in the same stroke.
  //
  // The baseline is taken from the row's spaces rather than from a majority of
  // the items: with two options and one of them highlighted, each background
  // occurs exactly once and a majority cannot say which is which. The padding a
  // terminal paints out to the right edge always carries the row's own colour,
  // so it can.
  const rowBg = dominantSpaceBackground(cells)
  if (rowBg === undefined) return undefined
  const highlighted = items.filter((it) => String(it.bg) !== rowBg)
  if (highlighted.length !== 1) return undefined

  const selected = items.indexOf(highlighted[0])

  // Deliberately unfiltered: the index has to keep counting the way the pane
  // counts, because the answer is a number of steps along this very row.
  // Dropping a row here would move every option after it.
  return { options: items.map((it) => it.text), selected }
}

/** Which way to walk the row, and how far. */
export interface Move {
  key: 'left' | 'right'
  count: number
}

/**
 * How to get from the pane's current selection to the option a wearer picked.
 *
 * Measured against a live OpenCode pane rather than read off its footer, which
 * says `⇆ select` - a glyph that reads as Tab and is not: Tab moves nothing
 * here. The arrow keys do, both ways, and both wrap round the ends. So the
 * shorter of the two walks is always available, which matters when a wearer
 * picks `Reject` on a row whose cursor sits at the far end: one press left
 * rather than several right.
 *
 * Callers send `count` presses of `key`, then Enter.
 */
export function moveTo(choices: InlineChoices, target: number): Move {
  const n = choices.options.length
  if (n === 0) return { key: 'right', count: 0 }
  const forward = ((target - choices.selected) % n + n) % n
  const backward = n - forward
  return forward <= backward
    ? { key: 'right', count: forward }
    : { key: 'left', count: backward }
}
