// What the ring actually sends a pane, and what it reads back.
//
// The picker used to drive the pane's own cursor with arrow keys, which made
// this screen a second cursor over the first. They came apart the moment
// anything redrew, and a multi-select redraws on every tick: the box changes,
// the relay re-reads the pane, the picker reopens on a new item at row 1 while
// the pane's cursor is still where it was. Measured against live Claude Code
// and Kimi Code panes on 2026-08-06 — three swipes into a fruit list, the panel
// offered `Banana` and the pane was sitting on `Type something`.
//
// The fixtures below are those panes, copied as they arrived through
// `pane.read` with `strip_ansi` on. They are what makes this file worth having:
// every one of these bugs was invisible in a hand-written string that looked
// like what the agents were assumed to draw.

import { describe, expect, test } from 'bun:test'
import { GlassesController, sameLabels } from '../controller.ts'
import type { GlassesPlatform } from '../controller.ts'
import { isChecked, looksMultiSelect } from '../display.ts'
import { extractChoices } from '../ws-client.ts'

// ── the panes themselves ──────────────────────────────────────────────────

/** Claude Code, `multiSelect: true`. Numbered *and* boxed, with a free-text
 *  row that drops its full stop the moment it grows a checkbox. */
const CLAUDE_MULTI = [
  '←  ☒ Color  ☐ Fruits  ☐ Speed  ✔ Submit  →',
  '',
  'Which fruits do you like?',
  '',
  '❯ 1. [ ] Apple',
  '  Crisp and sweet-tart.',
  '  2. [ ] Banana',
  '  Soft and sweet.',
  '  3. [✔] Cherry',
  '  Small and tangy-sweet.',
  '  4. [ ] Type something',
  '     Next',
  '',
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n')

/** Kimi Code, the same question. Not a digit anywhere on the screen — even
 *  though the hint line says `1-4` still works as a key. */
const KIMI_MULTI = [
  '  question',
  '',
  '  (✓) Color   Fruits   (○) Speed   Submit',
  '',
  '  ? Which fruits do you like?',
  '',
  '   [ ] Apple',
  '   [✓] Banana',
  '   [ ] Cherry',
  '   [ ] Other',
  '',
  '   ↑↓ select  1-4 / ↵ toggle  ←/→/tab switch  esc cancel',
].join('\n')

/** Kimi Code, single pick. Numbered, cursor drawn with U+2192. */
const KIMI_SINGLE = [
  '  ? How fast should it go?',
  '',
  '   → [1] Fast',
  '     [2] Slow',
  '     [3] Other',
  '',
  '   ↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel',
].join('\n')

// ── reading them ─────────────────────────────────────────────────────────

describe('reading a real multi-select', () => {
  test("Claude's numbered checkboxes keep their boxes", () => {
    expect(extractChoices(CLAUDE_MULTI)).toEqual(['[ ] Apple', '[ ] Banana', '[✔] Cherry'])
  })

  test("Kimi's unnumbered checkboxes are read at all", () => {
    // The whole question was invisible before: no digits, so the numeric run
    // that recognises every other option list had nothing to count, and the
    // panel sat on the previous question while the pane had moved on.
    expect(extractChoices(KIMI_MULTI)).toEqual(['[ ] Apple', '[✓] Banana', '[ ] Cherry'])
  })

  test('a numbered list is still read as one', () => {
    expect(extractChoices(KIMI_SINGLE)).toEqual(['Fast', 'Slow'])
  })

  test('the rows a wearer cannot answer are gone from both', () => {
    // `Type something.` in a single pick, `[ ] Type something` in a
    // multi-select — no full stop, and a checkbox in front. Matching the
    // literal string caught the first and missed the second.
    for (const pane of [CLAUDE_MULTI, KIMI_MULTI, KIMI_SINGLE]) {
      const joined = extractChoices(pane).join('|')
      expect(joined).not.toContain('Type something')
      expect(joined).not.toContain('Chat about this')
      expect(joined).not.toContain('Other')
    }
  })

  test('both are recognised as multi-selects, and the single pick is not', () => {
    expect(looksMultiSelect(extractChoices(CLAUDE_MULTI))).toBe(true)
    expect(looksMultiSelect(extractChoices(KIMI_MULTI))).toBe(true)
    expect(looksMultiSelect(extractChoices(KIMI_SINGLE))).toBe(false)
  })

  test('a ticked box is read as ticked, whichever check mark drew it', () => {
    // Claude Code writes U+2714 and Kimi writes U+2713. Only the lighter one
    // was listed, so every box Claude ticked read back empty: the send row
    // counted nothing and a wearer's own ticks looked like they went nowhere.
    expect(isChecked('[✔] Cherry')).toBe(true)
    expect(isChecked('[✓] Banana')).toBe(true)
    expect(isChecked('[ ] Apple')).toBe(false)
  })

  test("kimi's Other row is dropped even while it is being typed into", () => {
    // It grows a colon when it becomes the active text field, which is exactly
    // when leaving it in the picker does the most harm.
    expect(extractChoices(['   [ ] Apple', '   [✓] Banana', '   [ ] Other:'].join('\n'))).toEqual([
      '[ ] Apple',
      '[✓] Banana',
    ])
  })

  test('prose is still declined', () => {
    // The checkbox path is another way into the picker, so it has to refuse
    // what the numbered one refuses.
    expect(extractChoices('a paragraph\nand another\nand a third')).toEqual([])
    expect(extractChoices('[ ] the only box on screen')).toEqual([])
  })
})

// ── sending to them ──────────────────────────────────────────────────────

function platform(): GlassesPlatform {
  return {
    onDevice: false,
    render() {},
    renderHeader() {},
    requestExit() {},
    async startMicCapture() { return true },
    async stopMicCapture() {},
    async transcribeAudio() { throw new Error('not used here') },
  } as unknown as GlassesPlatform
}

type Internals = {
  enterChoice(
    options: string[],
    target: { sessionId: string; paneId?: string; itemId?: string },
    inline?: { options: string[]; selected: number },
  ): void
  inlineFromItem(item: { choices?: string[]; choiceInput?: string; choiceSelected?: number }):
    | { options: string[]; selected: number }
    | undefined
  sendChoiceKey(data: string): void
  handle(action: 'tap' | 'doubleTap' | 'swipeUp' | 'swipeDown'): Promise<void>
}

const inner = (c: GlassesController) => c as unknown as Internals

/** A controller in the picker, recording every key it sends the pane. */
function picker(
  options: string[],
  inline?: { options: string[]; selected: number },
): { c: GlassesController; keys: string[] } {
  const c = new GlassesController(platform())
  c.state.sessions = [{ id: 's1', name: 'ws', state: 'idle' }] as GlassesController['state']['sessions']
  const keys: string[] = []
  inner(c).sendChoiceKey = (data: string) => { keys.push(data) }
  inner(c).enterChoice(options, { sessionId: 's1', paneId: '%0', itemId: 'q1' }, inline)
  return { c, keys }
}

const FRUITS = ['[ ] Apple', '[ ] Banana', '[ ] Cherry']
const COLORS = ['Red', 'Green', 'Blue']

const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const ENTER = '\r'

/**
 * A row drawn side by side has no keys of its own, so it is answered by walking
 * the pane's own cursor and confirming. Which is only reached when the picker
 * was opened knowing where that cursor is - and that knowledge now arrives two
 * ways, because the server reads the same row.
 */
describe('a row answered by walking the pane', () => {
  const PERMISSION = ['Allow once', 'Allow always', 'Reject']

  test('walks forward from where the pane is, then confirms', async () => {
    const { c, keys } = picker(PERMISSION, { options: PERMISSION, selected: 0 })
    await inner(c).handle('swipeDown')
    await inner(c).handle('tap')
    expect(keys).toEqual([RIGHT, ENTER])
  })

  /** Both directions wrap, so the far end is one press back, not two forward. */
  test('takes the shorter way round', async () => {
    const { c, keys } = picker(PERMISSION, { options: PERMISSION, selected: 0 })
    await inner(c).handle('swipeDown')
    await inner(c).handle('swipeDown')
    await inner(c).handle('tap')
    expect(keys).toEqual([LEFT, ENTER])
  })

  test('picking where the pane already is sends only the confirm', async () => {
    const { c, keys } = picker(PERMISSION, { options: PERMISSION, selected: 0 })
    await inner(c).handle('tap')
    expect(keys).toEqual([ENTER])
  })

  /** Without the reading, the old numbered answer is still what is sent - which
   *  is right for every agent that numbers its options. */
  test('the same options with no reading are answered by number', async () => {
    const { c, keys } = picker(PERMISSION)
    await inner(c).handle('swipeDown')
    await inner(c).handle('tap')
    expect(keys).toEqual(['2'])
  })
})

/**
 * Where that reading comes from when the notification carries it.
 *
 * Once a relay item has choices, the app never reaches its own terminal scrape
 * for that pane - the tap path takes the item's list and opens the picker. So
 * the item is the only place the pane's cursor can come from, and an item that
 * cannot say where it is must not be treated as if it said zero.
 */
describe('reading a relay item', () => {
  test('an arrow item carries the pane cursor through', () => {
    const c = new GlassesController(platform())
    expect(
      inner(c).inlineFromItem({
        choices: ['Allow once', 'Allow always', 'Reject'],
        choiceInput: 'arrow',
        choiceSelected: 2,
      }),
    ).toEqual({ options: ['Allow once', 'Allow always', 'Reject'], selected: 2 })
  })

  test('a numbered item is not one of these', () => {
    const c = new GlassesController(platform())
    expect(inner(c).inlineFromItem({ choices: ['Yes', 'No'], choiceInput: 'number' })).toBeUndefined()
  })

  /** An older server sends neither field. Absent has to keep meaning "by
   *  number", or an upgraded app stops answering a server that has not moved. */
  test('an item from a server that knows nothing of this answers by number', () => {
    const c = new GlassesController(platform())
    expect(inner(c).inlineFromItem({ choices: ['Yes', 'No'] })).toBeUndefined()
  })

  /** A missing position is not a zero: walking from a guessed start is the
   *  blind cursor that had this removed once already. */
  test('an arrow item with no position is refused rather than assumed', () => {
    const c = new GlassesController(platform())
    expect(inner(c).inlineFromItem({ choices: ['a', 'b'], choiceInput: 'arrow' })).toBeUndefined()
    expect(
      inner(c).inlineFromItem({ choices: ['a', 'b'], choiceInput: 'arrow', choiceSelected: 5 }),
    ).toBeUndefined()
  })
})

describe('what a gesture sends the pane', () => {
  test('a swipe sends nothing at all', async () => {
    const { c, keys } = picker(COLORS)
    await inner(c).handle('swipeDown')
    await inner(c).handle('swipeDown')
    await inner(c).handle('swipeUp')
    expect(keys).toEqual([])
    // It is a display cursor now, and only that.
    expect(c.state.choiceIndex).toBe(1)
  })

  test('a single pick is answered by its own number', async () => {
    const { c, keys } = picker(COLORS)
    await inner(c).handle('swipeDown')
    await inner(c).handle('tap')
    expect(keys).toEqual(['2'])
  })

  test('a multi-select ticks by number and does not leave the picker', async () => {
    const { c, keys } = picker(FRUITS)
    await inner(c).handle('swipeDown')
    await inner(c).handle('swipeDown')
    await inner(c).handle('tap')
    expect(keys).toEqual(['3'])
    expect(c.state.mode).toBe('choice')
  })

  test('a tick shows immediately rather than waiting for the pane', async () => {
    const { c } = picker(FRUITS)
    await inner(c).handle('tap')
    expect(isChecked(c.state.choiceOptions[0])).toBe(true)
  })

  test('the send row advances the question with Tab, not Enter', async () => {
    // Enter on an option row in Claude Code toggles it. The multi-select's
    // send used to be a `\r`, so it ticked whatever the pane's cursor was
    // resting on and never submitted anything.
    const { c, keys } = picker(FRUITS)
    for (let i = 0; i < FRUITS.length; i++) await inner(c).handle('swipeDown')
    await inner(c).handle('tap')
    expect(keys).toEqual(['\t'])
  })
})

describe('where the cursor is after the pane redraws', () => {
  test('a re-read of the same question leaves it where the wearer put it', () => {
    const { c } = picker(FRUITS)
    c.state.choiceIndex = 2
    inner(c).enterChoice(['[ ] Apple', '[ ] Banana', '[✔] Cherry'], {
      sessionId: 's1', paneId: '%0', itemId: 'q1-again',
    })
    expect(c.state.choiceIndex).toBe(2)
  })

  test('a different question starts at the top', () => {
    const { c } = picker(FRUITS)
    c.state.choiceIndex = 2
    inner(c).enterChoice(['[ ] Cat', '[ ] Dog'], { sessionId: 's1', paneId: '%0', itemId: 'q2' })
    expect(c.state.choiceIndex).toBe(0)
  })

  test('another pane starts at the top even when it asks the same thing', () => {
    const { c } = picker(FRUITS)
    c.state.choiceIndex = 2
    inner(c).enterChoice(FRUITS, { sessionId: 's1', paneId: '%1', itemId: 'q3' })
    expect(c.state.choiceIndex).toBe(0)
  })
})

describe('telling one question from the same one re-read', () => {
  test('the boxes are not part of what a question says', () => {
    expect(sameLabels(FRUITS, ['[✔] Apple', '[ ] Banana', '[✓] Cherry'])).toBe(true)
  })

  test('the labels are', () => {
    expect(sameLabels(FRUITS, ['[ ] Apple', '[ ] Banana', '[ ] Durian'])).toBe(false)
    expect(sameLabels(FRUITS, ['[ ] Apple', '[ ] Banana'])).toBe(false)
  })
})
