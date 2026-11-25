import type { PaneQuestion } from './index';

/** A row that carries a box of its own, which on a multi-select is the pane's
 *  to tick - and, where it also takes text, is the field itself. */
const BOXED_ROW = /^\s*\[[ xX*✓✔]\]/;

/**
 * The rows that are a text field rather than a way to one.
 *
 * Only a multi-select has any. `[ ] Type something` is filled by typing while
 * the pane's cursor is on it, ticking the box in the same stroke; its digit
 * only ticks the box, and submitting it that way was measured on Claude Code
 * 2.1.228 returning an answer with nothing in it. `Chat about this` sits below
 * the closing rule with no box and is a choice like any other.
 */
export function fieldRowsOf(picker: PaneQuestion): number[] | undefined {
  if (!picker.multiSelect) return undefined;
  const out = picker.options.flatMap((o, i) =>
    o.freeText && BOXED_ROW.test(o.label) ? [i] : [],
  );
  return out.length > 0 ? out : undefined;
}

/**
 * The keys each row answers to, with the walk to a field worked out here.
 *
 * Deliberately not left to the app. Sending a key is all the glasses do with a
 * row, and everything about *which* key belongs on this side, where an agent
 * that redraws its picker can be followed by editing a reader - the app costs
 * an ehpk build and a store review to change, which is the reason more than one
 * thing about choosing keys used to be wrong for a while.
 *
 * A field is reached by walking the pane's own cursor to it, from where the
 * reader measured that cursor. Sparse on purpose: every row this leaves unset
 * is answered by its own number, which is every row on every other list.
 *
 * The walk does not wrap. Overshooting a field does not pick the wrong option -
 * it types the wearer's words into it.
 */
export function choiceKeysOf(picker: PaneQuestion, fieldRows: number[] | undefined): string[] | undefined {
  if (!fieldRows) return picker.choiceKeys;
  const keys = [...(picker.choiceKeys ?? [])];
  const from = picker.choiceCursor ?? 0;
  for (const row of fieldRows) {
    const steps = row - from;
    // An empty walk is the pane already sitting on the row, and travels as the
    // empty string: a row with no key at all would fall back to its digit,
    // which is the key this exists to keep off a field.
    keys[row] = (steps >= 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(steps));
  }
  return keys;
}
