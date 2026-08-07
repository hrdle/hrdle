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
  /** Spaces between the previous item and this one. */
  gapBefore: number
}

/** Split one painted line into the items a run of spaces separates. */
function itemsOf(cells: Array<{ ch: string; bg: string | null }>): Item[] {
  const items: Item[] = []
  let run: Array<{ ch: string; bg: string | null }> = []
  let gap = 0
  let gapBefore = 0

  const flush = () => {
    const text = run.map((c) => c.ch).join('').trim()
    if (text) {
      // The background of the item's own characters, not of the spaces around
      // it: a highlight is padded with spaces that carry it, and a plain item
      // is surrounded by spaces that do not.
      const painted = run.filter((c) => c.ch.trim())
      items.push({ text, bg: painted[0]?.bg ?? null, gapBefore })
    }
    run = []
  }

  for (const cell of cells) {
    if (cell.ch === ' ') {
      gap++
      if (gap === ITEM_GAP) flush()
      else if (gap < ITEM_GAP && run.length) run.push(cell)
      continue
    }
    if (gap > 0 && run.length === 0) gapBefore = gap
    gap = 0
    run.push(cell)
  }
  flush()
  return items
}

/**
 * A run of spaces this wide is a gap between *groups* rather than between
 * options, and ends the group.
 *
 * A pane wide enough draws the key hints on the same line as the options
 * instead of below them, and then every test that separates the two by shape
 * fails: the hints all carry the row's background, so "exactly one item painted
 * differently" is still satisfied and they join the menu. Measured on a
 * 121-column pane, the only seam is the space between them - options are
 * separated by 3, the hints internally by 1 and 2, and the two groups by 33.
 *
 * Six sits well clear of both, and being wrong low is the safe direction: an
 * over-eager split can only hide an option, while an over-lax one offers `enter
 * confirm` as an answer and confirms something the wearer never picked.
 */
const SECTION_GAP = 6

/** Split items into the groups a wide run of spaces separates. */
function sectionsOf(items: Item[]): Item[][] {
  const sections: Item[][] = []
  for (const item of items) {
    if (sections.length === 0 || item.gapBefore >= SECTION_GAP) sections.push([item])
    else sections[sections.length - 1].push(item)
  }
  return sections
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

/**
 * Glyphs an agent puts in front of a *toggle* rather than an option: a
 * checkbox, a tick, a radio.
 *
 * Claude Code's AskUserQuestion draws a tab bar above its question -
 * `←  ☒ 複数選択  ✔ Submit  →` - and it is a menu by every test this module
 * applies: the arrows carry no letters so they are dropped as furniture, and of
 * the two items left only the active tab is painted differently. Captured from
 * a live pane, the reader returned it as a two-option menu, and a wearer got a
 * picker offering "複数選択" and "Submit" for a question that was working.
 *
 * That would have been worse than the gap this module was written to close:
 * this one takes an agent that was answerable and makes it not.
 *
 * A tab carries its state as a glyph because it *has* a state - ticked, or not.
 * An option in a row of options has none; it is chosen by being chosen. So a
 * row containing one is a set of toggles, whatever else it looks like. Refusing
 * the whole row rather than dropping the item is deliberate: the walk counts
 * positions along the row the pane draws, and removing one from the middle
 * would move every option after it.
 *
 * Kimi draws the same bar and got through anyway, because it *wraps* its tick:
 * `(\u2713) intro.lead   Submit`, where the first item carries no bare glyph at
 * position 0 - it carries a bracket. Captured from the live pane on
 * 2026-08-08, `(\u2713) intro.lead` sits on the row's own background while `Submit`
 * is painted `48;2;79;168;255`, so "exactly one item painted differently" was
 * satisfied and a wearer was offered the tab bar as the answer to the
 * question - recorded in the picker as `>>> intro.lead / Submit`. Tapping it
 * would have switched tabs while looking like an answer.
 *
 * So the parenthesised form counts as a toggle too. Written as an alternation
 * rather than by adding `(` to the class: a bare `(` opens plenty of options
 * that are not toggles (`(Recommended)` is one of kimi's own), and only the
 * enclosed state marker makes it a tab.
 */
const TOGGLE_GLYPH =
  /^(?:[\u2610\u2611\u2612\u2713\u2714\u2717\u2718\u25cb\u25cf\u25ce\u25ef\u26ac[]|\([ xX*\u2713\u2714\u25cb\u25cf]?\))/

/**
 * Words that make a row a bar of actions rather than a set of answers.
 *
 * The glyph test above needs the agent to have drawn a state marker, and kimi
 * only draws its tick on the *inactive* tab: with the tab itself active the row
 * is `intro.lead   Submit`, one item highlighted and one not, which is
 * indistinguishable by shape from a genuine two-option menu. Both states were
 * captured from the same pane minutes apart on 2026-08-08.
 *
 * What survives in both is the word. `Submit` is a thing a question's chrome
 * does with the answers, never an answer - claude writes `\u2714 Submit` on its tab
 * bar and kimi `Submit` on its, and where either agent really does offer it as
 * an option it is numbered (`[1] Submit`) and read by a different path
 * entirely, before this one is ever consulted.
 *
 * Refusing costs at most a picker that does not open, which the wearer can
 * still answer from the pane; admitting costs an answer sent to the wrong
 * place. This module already chose that direction once, for the same reason.
 */
const ACTION_BAR_WORDS = new Set(['submit', 'cancel', 'done'])

/** Whether an item is one of those, ignoring the padding a highlight adds. */
function isActionWord(text: string): boolean {
  return ACTION_BAR_WORDS.has(text.trim().replace(/^[\u2713\u2714\u2611]\s*/, '').toLowerCase())
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
  const all = itemsOf(cells).filter((it) => !isFurniture(it.text))
  if (all.length < 2) return undefined

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

  // The menu is the group the highlight is in. On a narrow pane that is the
  // whole row; on a wide one the key hints are sharing it, and they are a
  // group of their own.
  const withHighlight = sectionsOf(all).filter((section) =>
    section.some((it) => String(it.bg) !== rowBg),
  )
  if (withHighlight.length !== 1) return undefined
  const items = withHighlight[0]
  if (items.length < 2) return undefined
  if (items.some((it) => it.text.length > MAX_ITEM_CHARS)) return undefined

  if (items.some((it) => TOGGLE_GLYPH.test(it.text))) return undefined

  if (items.some((it) => isActionWord(it.text))) return undefined

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
