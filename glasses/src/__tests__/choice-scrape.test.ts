// Reading a pane for the options it is offering, and — mostly — declining to.
//
// Tapping a waiting session looks at the pane before opening the microphone:
// if the agent is holding out a menu, the ring should answer it directly. The
// cost of getting that wrong is not a missing feature, it is a picker full of
// sentences, with a cursor that moves and an Enter that sends one of them to
// an agent that asked nothing.
//
// Which is what happened on 2026-08-03: three lines of a written plan became
// three choices. Two things had gone wrong and either alone was enough.

import { describe, expect, test } from 'bun:test'
import { extractChoices, stripAnsi } from '../ws-client.ts'

describe('stripAnsi', () => {
  test('keeps Japanese', () => {
    // The bug: the last rule deleted every non-ASCII character, so a Japanese
    // pane arrived as the punctuation between its words.
    expect(stripAnsi('2. スクリーンショットを撮り直す')).toBe('2. スクリーンショットを撮り直す')
  })

  test('still removes escape sequences and control characters', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('a\x00b\x07c')).toBe('abc')
  })

  test('still folds box drawing onto ASCII the panel is sure of', () => {
    expect(stripAnsi('──')).toBe('--')
    expect(stripAnsi('❯ 1. Yes')).toBe('> 1. Yes')
  })
})

describe('extractChoices', () => {
  test('reads a real menu', () => {
    const pane = [
      'Do you want to proceed?',
      '',
      '❯ 1. Yes',
      '  2. Yes, and do not ask again',
      '  3. No',
    ].join('\n')
    expect(extractChoices(stripAnsi(pane))).toEqual([
      'Yes',
      'Yes, and do not ask again',
      'No',
    ])
  })

  test('reads a menu written with parentheses', () => {
    expect(extractChoices('1) Postgres\n2) SQLite')).toEqual(['Postgres', 'SQLite'])
  })

  test('declines a numbered list written as prose', () => {
    // The actual pane from the report, after stripAnsi. A plan, not a menu:
    // the numbering is right but it sits in a paragraph and scrolls away.
    const pane = [
      'やること',
      '',
      '1. 実機で double-tap を検証（ログに shutDownPageContainer refused by host が出ないか）',
      '',
      'これは審査のブロッカーです。',
      '',
      '2. スクリーンショットを撮り直す ── 実機の録画から、加工せず',
      '',
      '審査者はこれを編集されたと見なしました。',
      '',
      '3. 直したら v0.0.38 として再提出',
    ].join('\n')
    expect(extractChoices(pane)).toEqual([])
  })

  test('declines a single numbered line', () => {
    expect(extractChoices('1. the only thing on screen')).toEqual([])
  })

  test('declines numbering that does not start at 1', () => {
    expect(extractChoices('3. third\n4. fourth')).toEqual([])
  })

  test('ignores a numbered list far above the prompt', () => {
    const pane = ['1. old', '2. older', ...Array(30).fill('output'), 'done'].join('\n')
    expect(extractChoices(pane)).toEqual([])
  })

  test('takes the menu at the bottom rather than the prose above it', () => {
    const pane = [
      '1. first I did this',
      'and then a paragraph about it',
      '2. then I did that',
      'and another paragraph',
      'Which one?',
      '❯ 1. this',
      '  2. that',
    ].join('\n')
    expect(extractChoices(stripAnsi(pane))).toEqual(['this', 'that'])
  })
})
