// Which row of a picker is a text field, and what key reaches it.
//
// Both answers are worked out here rather than in the glasses, and that is the
// point of the file. The app sends whatever key a row was given and has no rule
// of its own about which - a rule there costs an ehpk build and a store review
// every time an agent redraws its picker, and this one was measured changing
// between two rows of the same list.
//
// Measured against Claude Code 2.1.228 on 2026-08-12, driving a live pane key
// by key:
//
//   5. [ ] Type something     <- a field. Typing while the pane's cursor is on
//                                it fills it and ticks the box together. Its
//                                digit only ticks the box, and submitting that
//                                way returns an answer with nothing in it.
//   ─────────────────────────
//   6. Chat about this        <- a choice. Its digit takes the question down
//                                and leaves a prompt open.

import { describe, expect, test } from 'bun:test';
import { choiceKeysOf, fieldRowsOf } from '../glasses-relay';
import type { PaneQuestion } from '../pane-readers';

const DOWN = '\x1b[B';
const UP = '\x1b[A';

function row(label: string, freeText = false) {
  return { label, detail: '', ...(freeText ? { freeText: true } : {}) };
}

/** The multi-select from the recording, as the reader hands it over. */
function multi(choiceCursor = 0): PaneQuestion {
  return {
    options: [
      row('[ ] 認証機能'),
      row('[ ] 通知'),
      row('[ ] ダークモード'),
      row('[ ] 多言語対応'),
      row('[ ] Type something', true),
      row('Chat about this', true),
    ],
    multiSelect: true,
    choiceCursor,
  };
}

/** The single-pick list, whose text row is a choice like any other. */
const SINGLE: PaneQuestion = {
  options: [row('vaultに自分で保存'), row('チャットで直接教える'), row('Chat about this', true)],
  multiSelect: false,
  choiceCursor: 0,
};

describe('which rows are a field', () => {
  test('a boxed text row on a multi-select is one', () => {
    expect(fieldRowsOf(multi())).toEqual([4]);
  });

  test('the row below the rule is not - it has no box', () => {
    // It is answered by its number and the question is over, which is a
    // different thing to do with a microphone's output.
    expect(fieldRowsOf(multi())).not.toContain(5);
  });

  test('a single-pick list has none at all', () => {
    expect(fieldRowsOf(SINGLE)).toBeUndefined();
  });

  test('a multi-select with nothing to type into has none', () => {
    const plain: PaneQuestion = {
      options: [row('[ ] りんご'), row('[ ] みかん')],
      multiSelect: true,
    };
    expect(fieldRowsOf(plain)).toBeUndefined();
  });
});

describe('the key a field answers to', () => {
  test('is the walk from where the pane\'s cursor was measured', () => {
    const keys = choiceKeysOf(multi(0), [4]);
    expect(keys?.[4]).toBe(DOWN.repeat(4));
  });

  test('walks back up when the cursor is past the row', () => {
    expect(choiceKeysOf(multi(5), [4])?.[4]).toBe(UP);
  });

  test('is the empty string when the pane is already there', () => {
    // Not "no key": a row with none falls back to its own digit, which is the
    // key this exists to keep off a field - it ticks the box and types nothing.
    expect(choiceKeysOf(multi(4), [4])?.[4]).toBe('');
  });

  test('leaves every other row to its own number', () => {
    const keys = choiceKeysOf(multi(0), [4]);
    // Sparse on purpose: unset means the position, which is how claude, codex
    // and kimi answer every row they draw.
    expect(keys?.[0]).toBeUndefined();
    expect(keys?.[5]).toBeUndefined();
  });

  test('a list with no fields is handed through untouched', () => {
    expect(choiceKeysOf(SINGLE, undefined)).toBeUndefined();
  });

  test('keys an agent wrote itself are kept', () => {
    // Grok writes its own, and one of them is a letter.
    const grok: PaneQuestion = {
      options: [row('そのまま残す'), row('Type your answer here', true)],
      multiSelect: false,
      choiceKeys: ['1', 'z'],
    };
    expect(choiceKeysOf(grok, undefined)).toEqual(['1', 'z']);
  });

  test('a walk overwrites only its own row', () => {
    const both: PaneQuestion = {
      ...multi(0),
      choiceKeys: ['1', '2', '3', '4', '5', '6'],
    };
    expect(choiceKeysOf(both, [4])).toEqual(['1', '2', '3', '4', DOWN.repeat(4), '6']);
  });
});
