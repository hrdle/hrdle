// Reading OpenCode's Confirm prompt.
//
// The fixture is a live 0.15.x pane captured on 2026-08-13, escape sequences
// and all, because the colours are the point: every row is `N. [x] label` at
// the same indent and only the background says which one the cursor is on. It
// is held in a file rather than inline for the same reason - 6KB of SGR is not
// something anyone should have to read past to reach the assertions.
//
// What this reader is for: the rows are numbered, so the general numbered rule
// matched them and served them with no `choiceInput`, which means "answer by
// the number". The footer says otherwise - `↑↓ select  enter toggle` - and a
// wearer who ticked four boxes had three arrive, in a different combination.

import { describe, expect, test } from 'bun:test';
import { readOpenCodePicker } from '../opencode';

const ANSI = await Bun.file(new URL('./fixtures/opencode-confirm.ansi.txt', import.meta.url)).text();
const PAINTED = ANSI.split('\n');
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR is the point
const LINES = PAINTED.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

describe('the Confirm prompt', () => {
  const p = readOpenCodePicker({ lines: LINES, painted: PAINTED });

  test('its rows are the options, without the numbers that do not answer them', () => {
    // The box stays on: it is what tells the app this is a multi-select, and
    // the only place the ticks are shown. The first row is ticked here.
    expect(p?.options.map((o) => o.label)).toEqual([
      '[✓] 現状のコードを調査する',
      '[ ] 機能を追加する',
      '[ ] バグを修正する',
      '[ ] リファクタリングする',
      '[ ] Type your own answer',
    ]);
  });

  test('each carries what it says about itself', () => {
    expect(p?.options[0].detail).toBe('まず作業対象や目的をコードから洗い出して進めたい');
    expect(p?.options[1].detail).toBe('新しい機能や画面を追加する作業をしたい');
  });

  test('the row that takes text is marked', () => {
    expect(p?.options.at(-1)).toMatchObject({ label: '[ ] Type your own answer', freeText: true });
  });

  test('it is answered by walking, not by typing a digit', () => {
    // The whole reason this file exists. Without `choiceInput` the item reads
    // as a numbered one and the glasses send `1`..`5` at a pane where digits
    // do nothing.
    expect(p?.choiceInput).toBe('arrow');
  });

  test('and the walk is up and down, not left and right', () => {
    // Every `arrow` pane before this one was a row of buttons. Sending left and
    // right at a list moves nothing at all.
    expect(p?.choiceAxis).toBe('column');
  });

  test('which row the cursor is on comes off the paint', () => {
    // The fourth row in the capture, while the *first* is the one that is
    // ticked - the two are independent, and stripped of colour the five rows
    // are identical in shape. This is the one thing the text cannot say.
    expect(p?.choiceSelected).toBe(3);
    expect(p?.options[0].label).toBe('[✓] 現状のコードを調査する');
  });

  test('the question is the line above the rows', () => {
    expect(p?.question).toContain('次に着手したいタスクのタイプ');
  });

  test('finishing it is tab then Enter', () => {
    // `enter` toggles a row here rather than confirming, so the prompt is
    // finished from the screen `tab` opens. The app splits this into two
    // keystrokes, which is what a pane reads them as.
    expect(p?.choiceSend).toBe('\t\r');
  });
});

describe('without the paint', () => {
  test('the options go with the walk rather than being answered wrongly', () => {
    // A reader handed no colours cannot say where the cursor is, and a walk
    // from a guessed position toggles the wrong row. The relay drops the
    // options when `choiceInput` is absent, which leaves the question showing
    // and nothing to answer it with - the honest half.
    const p = readOpenCodePicker({ lines: LINES });
    expect(p?.options.length).toBe(5);
    expect(p?.choiceInput).toBeUndefined();
    expect(p?.choiceSelected).toBeUndefined();
  });
});

describe('the screen tab opens', () => {
  const REVIEW = [
    '  ┃   次に着手するタスク   Confirm',
    '  ┃',
    '  ┃  Review',
    '  ┃',
    '  ┃  次に着手するタスク: 現状のコードを調査する',
    '  ┃',
    '  ┃  ⇆ tab  enter submit  esc dismiss',
    '  ┃',
  ];
  const p = readOpenCodePicker({ lines: REVIEW, painted: REVIEW });

  test('it is one thing to press, not a list', () => {
    expect(p?.options.map((o) => o.label)).toEqual(['Submit']);
    expect(p?.multiSelect).toBe(false);
  });

  test('pressing it is a walk of no steps and Enter', () => {
    expect(p?.choiceInput).toBe('arrow');
    expect(p?.choiceSelected).toBe(0);
  });

  test('it says what is about to be submitted', () => {
    expect(p?.question).toBe('次に着手するタスク: 現状のコードを調査する');
  });
});

describe('a pane with no prompt on it', () => {
  test('the transcript is not a prompt', () => {
    expect(
      readOpenCodePicker({
        lines: ['  ┃', '  ┃  もう一度、同じ形式で質問してください。', '  ┃', '     → Asked 1 question'],
      }),
    ).toBeUndefined();
  });

  test('a framed block with no footer is not a prompt', () => {
    expect(readOpenCodePicker({ lines: ['  ┃  1. [ ] one', '  ┃  2. [ ] two'] })).toBeUndefined();
  });
});
