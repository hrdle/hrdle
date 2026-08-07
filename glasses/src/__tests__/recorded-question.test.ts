import { describe, expect, test } from 'bun:test'
;(globalThis as unknown as { __STORAGE_PREFIX__: string }).__STORAGE_PREFIX__ = 'hrdle-'
;(globalThis as unknown as { __LEGACY_STORAGE_PREFIXES__: string[] }).__LEGACY_STORAGE_PREFIXES__ = []

import { inlineChoicesInRow } from '../../../shared/inline-choices'
import { KIMI_QUESTION_TAB_BAR_PLAIN, OPENCODE_PERMISSION_ROW } from './fixtures/opencode-permission'

/**
 * Where the picker's options come from, and where they no longer do.
 *
 * The rule the controller now applies: what the agent recorded beats the
 * screen, a numbered list is still read for every agent (a permission prompt
 * is numbered and is in no record), and the colour guess - one item painted
 * unlike its neighbours - is used only for an agent that keeps no record at
 * all.
 *
 * Both times that guess was wrong it was on an agent that does keep one. A
 * kimi question's tab bar was offered as that question's answer, and a Claude
 * pane that was not asking anything offered `1039 / const pane =
 * state.selectedPaneId` from a `Read` result.
 */

/** The controller's rule, in the shape the test can state it. */
function usesColourGuess(pane: { questionKnown?: boolean }): boolean {
  return pane.questionKnown !== true
}

/** The rows the controller hands the picker for a recorded question. */
function rowsFor(q: { options: Array<{ label: string; description?: string }> }): string[] {
  return q.options.map((o) => (o.description ? `${o.label} - ${o.description}` : o.label))
}

describe('a question the agent recorded', () => {
  test('its descriptions travel with the labels', () => {
    expect(rowsFor({
      options: [
        { label: '案A (Recommended)', description: '現行のトーンに一番近い' },
        { label: '案B', description: '最短' },
        { label: '案C' },
      ],
    })).toEqual([
      '案A (Recommended) - 現行のトーンに一番近い',
      '案B - 最短',
      '案C',
    ])
  })
})

describe('the colour guess', () => {
  test('is not consulted for an agent that keeps a record', () => {
    // claude and kimi. Where they say nothing is being asked, a row that looks
    // like a menu is not one.
    expect(usesColourGuess({ questionKnown: true })).toBe(false)
  })

  test('is still consulted where the screen is the only source', () => {
    // opencode's permission row is a real menu and lives nowhere else.
    expect(usesColourGuess({ questionKnown: false })).toBe(true)
    expect(usesColourGuess({})).toBe(true)
    expect(inlineChoicesInRow(OPENCODE_PERMISSION_ROW)).toEqual({
      options: ['Allow once', 'Allow always', 'Reject'],
      selected: 0,
    })
  })

  test("the rows it used to be wrong about are refused before it runs", () => {
    // Kept as a record of what the guess does on its own: this row still reads
    // as a menu to it, and the gate is what keeps it from being offered.
    expect(usesColourGuess({ questionKnown: true })).toBe(false)
    expect(inlineChoicesInRow(KIMI_QUESTION_TAB_BAR_PLAIN)).toBeUndefined()
  })
})
