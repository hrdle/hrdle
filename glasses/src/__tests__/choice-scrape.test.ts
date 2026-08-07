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

  test("reads kimi's menu, which numbers itself differently", () => {
    // Captured from a real kimi-k3 pane on 2026-08-04, through
    // `pane.read`. Two things here that claude does not do: the options are
    // bracketed rather than dotted, the cursor is U+2192 rather than U+276F -
    // and neither was read, so a blocked kimi workspace produced a waiting
    // item with no choices at all and the picker never opened for it.
    const pane = [
      '  ? テストはどう分けますか?',
      '',
      '   → [1] モジュールごとに1ファイル',
      '         各モジュールに対応するテストファイルを個別に作成します',
      '     [2] 全部で1ファイル',
      '         すべてのテストを1つのファイルにまとめます',
      '     [3] Other',
      '',
      '   ↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel',
    ].join('\n')
    // The description lines sit between the options, so the run has to
    // tolerate the gap - and each one comes back attached to the label above
    // it, because on a bare label like `案 A` it is the only thing that says
    // what picking it does. `Other` is dropped as unanswerable.
    expect(extractChoices(stripAnsi(pane))).toEqual([
      'モジュールごとに1ファイル - 各モジュールに対応するテストファイルを個別に作成します',
      '全部で1ファイル - すべてのテストを1つのファイルにまとめます',
    ])
  })

  test("reads kimi's submit screen", () => {
    // The third step of one AskUserQuestion call, and the one that actually
    // sends the answers - a picker that stopped short of it would leave the
    // pane holding two answers it was never told to submit.
    const pane = [
      '  Ready to submit your answers?',
      '',
      '   → [1] Submit',
      '     [2] Cancel',
      '',
      '   ↑↓ select  1/2 choose  ↵ confirm  ←/→/tab switch  esc cancel',
    ].join('\n')
    expect(extractChoices(stripAnsi(pane))).toEqual(['Submit', 'Cancel'])
  })

  test('drops the rows the ring cannot answer', () => {
    // Both of claude's trailing rows open free-text entry. They were offered
    // here as selectable options while the same pane read through the server
    // offered two - the picker and the notice disagreeing about one pane.
    const pane = [
      'テストはどう分けますか?',
      '❯ 1. モジュールごとに1ファイル',
      '  2. 全部で1ファイル',
      '  3. Type something.',
      '  4. Chat about this',
    ].join('\n')
    expect(extractChoices(stripAnsi(pane))).toEqual(['モジュールごとに1ファイル', '全部で1ファイル'])
  })

  test('a menu that is only unanswerable rows comes back empty', () => {
    expect(extractChoices('1. Type something.\n2. Chat about this')).toEqual([])
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
