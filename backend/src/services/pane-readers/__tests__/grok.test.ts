// Reading Grok Build's picker.
//
// Both fixtures are live grok 0.2.103 panes, captured on 2026-08-12: the picker
// it draws at startup, and one its agent raised when asked to offer options.
// Neither had ever been read - grok agrees with nobody about how to draw a row,
// so the general rule matched not one line of either.

import { describe, expect, test } from 'bun:test';
import { readGrokPicker } from '../grok';

/** A question its agent raised. The description sits to the RIGHT of the label
 *  on the same row, and the scrollbar is painted down the far edge. */
const QUESTION = [
  '    ◆ Waiting on answers for fixture.txt をどう扱いますか？          2.9s ⇣17.0k [stop]',
  '  [Click here to Upgrade] or use Ctrl+O',
  '  ┃',
  '  ┃  fixture.txt をどう扱いますか？',
  '  ┃',
  '  ┃  1 (○) そのまま残す          現状の内容（hello）を変更せず置いておく                █',
  '  ┃  2 (○) 内容を拡張する         より意味のあるサンプルデータに書き換える              █',
  '  ┃  3 (○) 削除する            不要なファイルとして fixture.txt を削除する              █',
  '  ┃  z (○) Type your answer here',
  '  ┃',
  '  ┃  ↑/↓ navigate · y copy                                        Enter:submit',
  '  ┃',
  '  Esc:unselect  │  Tab:scrollback  │  Shift+x:dismiss',
];

describe('a question grok is waiting on', () => {
  const p = readGrokPicker(QUESTION);

  test('its rows are read, though none of them is numbered the usual way', () => {
    // `1 (○) …` - no full stop, no bracket. The general rule wants `\d+[.)]`
    // and matched nothing, so a wearer got the question and no way to answer.
    expect(p?.options.map((o) => o.label)).toEqual([
      'そのまま残す',
      '内容を拡張する',
      '削除する',
      'Type your answer here',
    ]);
  });

  test('the description to the right of a label comes with it', () => {
    expect(p?.options[0].detail).toBe('現状の内容（hello）を変更せず置いておく');
  });

  test('the keys travel, because they are not the rows’ positions', () => {
    // The free-text row answers to `z`. Counting would have sent grok a `4` it
    // has no option for.
    expect(p?.choiceKeys).toEqual(['1', '2', '3', 'z']);
    expect(p?.choiceInput).toBe('number');
  });

  test('the text-entry row is marked', () => {
    expect(p?.options.at(-1)).toMatchObject({ label: 'Type your answer here', freeText: true });
  });

  test('the question is the line above the rows', () => {
    expect(p?.question).toBe('fixture.txt をどう扱いますか？');
  });

  test('the scrollbar is not part of a description', () => {
    expect(p?.options.every((o) => !o.detail.includes('█'))).toBe(true);
  });
});

describe('what it declines', () => {
  test('a pane with no framed prompt on it', () => {
    expect(readGrokPicker(['  some output', '  1 (○) not framed'])).toBeUndefined();
  });

  test('a framed block with no hint line is not a prompt', () => {
    expect(readGrokPicker(['  ┃  1 (○) one', '  ┃  2 (○) two'])).toBeUndefined();
  });

  test('grok prose is not a menu', () => {
    expect(
      readGrokPicker(['  ┃  Here is what I would do:', '  ┃  1. first', '  ┃  2. second', '  ┃  ↑/↓ navigate']),
    ).toBeUndefined();
  });
});
