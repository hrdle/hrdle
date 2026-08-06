import { describe, expect, test } from 'bun:test'
import {
  extractInlineChoices,
  inlineChoicesInRow,
  paintedChars,
  moveTo,
} from '../../../shared/inline-choices'
import { extractChoices } from '../ws-client'
import {
  OPENCODE_FOOTER_ROW,
  OPENCODE_PERMISSION_ROW,
  OPENCODE_PERMISSION_ROW_WIDE,
} from './fixtures/opencode-permission'

/**
 * OpenCode draws its permission prompt as one horizontal row with no numbering
 * and no checkboxes, so neither shape `extractChoices` knows can see it. The
 * row directly beneath is the key hints, which as text is the same shape - the
 * two are told apart by their paint, and by nothing else.
 */

/**
 * A row as a terminal actually emits one: items, and then padding out to the
 * width of the pane carrying the row's own background. The padding is not
 * decoration - it is the largest sample of that background there is, and what
 * the reader takes its baseline from. A hand-written row without it is not a
 * row a pane ever draws.
 */
const ROW_BG = '30;30;30'
function row(...items: Array<[text: string, bg?: string]>): string {
  const pad = (n: number) => `\x1b[48;2;${ROW_BG}m${' '.repeat(n)}\x1b[0m`
  const painted = items
    .map(([text, bg]) => `\x1b[48;2;${bg ?? ROW_BG}m${text}\x1b[0m`)
    .join(pad(3))
  return pad(2) + painted + pad(20)
}

describe('paintedChars', () => {
  test('carries the background through a run of text', () => {
    const cells = paintedChars('\x1b[48;2;10;20;30mab\x1b[0mc')
    expect(cells.map((c) => c.ch).join('')).toBe('abc')
    expect(cells.map((c) => c.bg)).toEqual(['10;20;30', '10;20;30', null])
  })

  test('a reset and an explicit default background both clear it', () => {
    expect(paintedChars('\x1b[48;2;1;1;1mx\x1b[49my').map((c) => c.bg)).toEqual(['1;1;1', null])
    expect(paintedChars('\x1b[48;2;1;1;1mx\x1b[my').map((c) => c.bg)).toEqual(['1;1;1', null])
  })

  /** `48;2;r;g;b` has to be consumed whole, or `2` reads as its own code. */
  test('truecolor arguments are not mistaken for further codes', () => {
    expect(paintedChars('\x1b[0;38;2;9;9;9;48;2;7;7;7mx').map((c) => c.bg)).toEqual(['7;7;7'])
  })

  test('256-colour and the legacy 16 are understood', () => {
    expect(paintedChars('\x1b[48;5;208mx').map((c) => c.bg)).toEqual(['i208'])
    expect(paintedChars('\x1b[44mx').map((c) => c.bg)).toEqual(['44'])
  })
})

describe('inlineChoicesInRow', () => {
  test('reads a real OpenCode permission row, and which option is selected', () => {
    const found = inlineChoicesInRow(OPENCODE_PERMISSION_ROW)
    expect(found).toEqual({
      options: ['Allow once', 'Allow always', 'Reject'],
      selected: 0,
    })
  })

  /**
   * The row that made a text-only rule impossible. Same shape as the menu -
   * short phrases separated by runs of spaces - but every item shares one
   * background, so there is no selection and therefore no menu.
   */
  test('the key hints under it are not a menu', () => {
    expect(inlineChoicesInRow(OPENCODE_FOOTER_ROW)).toBeUndefined()
  })

  test('the gutter the pane frames with is not an option', () => {
    const found = inlineChoicesInRow(
      `\x1b[48;2;20;20;20m┃\x1b[0m${row(['Yes', '9;9;9'], ['No'])}`,
    )
    expect(found?.options).toEqual(['Yes', 'No'])
  })

  test('plain prose with no paint is not a menu', () => {
    expect(inlineChoicesInRow('  the quick brown  fox jumps  over')).toBeUndefined()
  })

  test('a row where everything is highlighted is not a menu either', () => {
    const all = row(['Yes', '9;9;9'], ['No', '9;9;9'], ['Maybe', '9;9;9'])
    expect(inlineChoicesInRow(all)).toBeUndefined()
  })

  test('two highlighted items are ambiguous and refused', () => {
    const two = row(['A', '9;9;9'], ['B', '9;9;9'], ['C'], ['D'])
    expect(inlineChoicesInRow(two)).toBeUndefined()
  })

  test('a single painted item is not a row of choices', () => {
    expect(inlineChoicesInRow(row(['Only one', '9;9;9']))).toBeUndefined()
  })

  /** A sentence that happens to be painted is prose, not a set of buttons. */
  test('an over-long item disqualifies the row', () => {
    expect(inlineChoicesInRow(row(['x'.repeat(60), '9;9;9'], ['short']))).toBeUndefined()
  })

  test('a single space stays inside an option', () => {
    const found = inlineChoicesInRow(row(['Allow once', '9;9;9'], ['Reject']))
    expect(found?.options).toEqual(['Allow once', 'Reject'])
  })
})

/**
 * A pane wide enough draws the key hints on the SAME line as the options
 * rather than below them. Which shape appears is decided by the pane's width,
 * not by the version, so a reader built from the narrow capture alone works on
 * a phone and fails on a desktop-sized pane.
 *
 * It fails in the worst available way: the hints all carry the row's own
 * background, so "exactly one item painted differently" is still satisfied and
 * they join the menu. A wearer is then offered `enter confirm` as an answer,
 * and picking it walks the pane onto a real option and presses Enter - an
 * answer nobody chose, confirmed. Found by the work-1 session against a
 * 121-column pane.
 */
describe('when the key hints share the options line', () => {
  test('only the options come back', () => {
    expect(inlineChoicesInRow(OPENCODE_PERMISSION_ROW_WIDE)).toEqual({
      options: ['Allow once', 'Allow always', 'Reject'],
      selected: 0,
    })
  })

  /** The seam is the space between the groups: options are separated by 3, the
   *  hints internally by 1 and 2, and the two groups by 33. */
  test('a wide run of spaces ends the group, a narrow one does not', () => {
    const together = `${row(['A', '9;9;9'], ['B'])}${' '.repeat(20)}${row(['ctrl+f x'], ['enter y'])}`
    expect(inlineChoicesInRow(together)?.options).toEqual(['A', 'B'])
  })

  /** Two separated groups each holding a highlight is not one menu, and
   *  guessing which is meant would be worse than declining. */
  test('a highlight in each group is refused', () => {
    const both = `${row(['A', '9;9;9'], ['B'])}${' '.repeat(20)}${row(['C', '9;9;9'], ['D'])}`
    expect(inlineChoicesInRow(both)).toBeUndefined()
  })

  test('a group holding only the highlight is not a menu', () => {
    const alone = `${row(['Solo', '9;9;9'])}${' '.repeat(20)}${row(['x'], ['y'])}`
    expect(inlineChoicesInRow(alone)).toBeUndefined()
  })
})

describe('extractInlineChoices', () => {
  test('finds the row among the lines around it', () => {
    const found = extractInlineChoices([
      '  ┃  △ Permission required',
      '  ┃',
      OPENCODE_PERMISSION_ROW,
      '  ┃',
      OPENCODE_FOOTER_ROW,
    ])
    expect(found?.options).toEqual(['Allow once', 'Allow always', 'Reject'])
  })

  /** A pane redraws its prompt in place; the lowest row is the live one. */
  test('the newest row wins', () => {
    const older = row(['Old A', '9;9;9'], ['Old B'])
    const found = extractInlineChoices([older, '  ┃', OPENCODE_PERMISSION_ROW])
    expect(found?.options).toEqual(['Allow once', 'Allow always', 'Reject'])
  })

  test('nothing on a pane with no prompt', () => {
    expect(extractInlineChoices(['just', 'some', 'output'])).toBeUndefined()
  })

  test('a row far above the tail is out of reach', () => {
    const lines = [OPENCODE_PERMISSION_ROW, ...new Array(40).fill('  ┃')]
    expect(extractInlineChoices(lines)).toBeUndefined()
  })
})

/**
 * Measured against a live OpenCode pane on 2026-08-06, not read off its footer.
 * The footer says `\u21c6 select`, which reads as Tab; Tab moves nothing. The
 * arrow keys move it, both ways, and both wrap:
 *
 *   right: 0 -> 1 -> 2 -> 0        left: 2 -> 1,  0 -> 2
 */
describe('moveTo', () => {
  const choices = { options: ['Allow once', 'Allow always', 'Reject'], selected: 0 }

  test('staying put is no presses at all', () => {
    expect(moveTo(choices, 0)).toEqual({ key: 'right', count: 0 })
  })

  test('walks forward when forward is nearer', () => {
    expect(moveTo(choices, 1)).toEqual({ key: 'right', count: 1 })
  })

  /** Both directions wrap, so the far end of the row is one press backwards
   *  rather than several forwards. */
  test('walks backward when backward is nearer', () => {
    expect(moveTo(choices, 2)).toEqual({ key: 'left', count: 1 })
    expect(moveTo({ ...choices, selected: 2 }, 0)).toEqual({ key: 'right', count: 1 })
  })

  test('ties go forward', () => {
    const four = { options: ['a', 'b', 'c', 'd'], selected: 0 }
    expect(moveTo(four, 2)).toEqual({ key: 'right', count: 2 })
  })

  test('an empty row asks for nothing', () => {
    expect(moveTo({ options: [], selected: 0 }, 0)).toEqual({ key: 'right', count: 0 })
  })
})

describe('alongside the existing readers', () => {
  /**
   * The reason this module exists: the numbered and checkbox readers see
   * nothing in an OpenCode prompt, which is what left a wearer with a waiting
   * notification and no way to answer it.
   */
  test('the numbered reader still finds nothing here', () => {
    const pane = [OPENCODE_PERMISSION_ROW, OPENCODE_FOOTER_ROW].join('\n')
    expect(extractChoices(pane)).toEqual([])
  })
})
