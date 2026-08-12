/**
 * Reading Grok Build's picker off the pane it draws it on.
 *
 * Grok agrees with nobody about how to draw a list. Every other agent numbers
 * its rows `1.` or `[1]`; grok writes the key, a space, and a radio:
 *
 * ```
 *  ┃  fixture.txt をどう扱いますか？
 *  ┃
 *  ┃  1 (○) そのまま残す      現状の内容を変更せず置いておく
 *  ┃  2 (○) 内容を拡張する     より意味のあるサンプルに書き換える
 *  ┃  3 (○) 削除する          不要なファイルとして削除する
 *  ┃  z (○) Type your answer here
 *  ┃
 *  ┃  ↑/↓ navigate · y copy                                  Enter:submit
 * ```
 *
 * So the general rule - which wants `\d+[.)]` - matched not one row of it, and
 * a wearer was shown `Run Grok Build in a project directory?` with nothing to
 * answer it with. Measured against grok 0.2.103 on 2026-08-12, on both the
 * picker it draws at startup and one its agent raised when asked to.
 *
 * Two more things are its own. The description sits to the RIGHT of the label
 * on the same row rather than under it, separated by a run of spaces - so a row
 * read whole carries both, and reading it whole is what the general rule would
 * have done. And the key is not the row's position: the free-text row is `z`,
 * so `index + 1` sends grok a `4` it has no option for. The keys travel with
 * the choices for that reason.
 */

import type { PaneQuestion } from './index';
import { isFreeText, type PickerOption, truncateDetail } from './shared';

/** The rule grok frames its prompt with, down the left of every line. */
const LEFT_RULE = /^\s*┃\s?/;

/** The line that says how the prompt is answered - grok's, specifically, so
 *  this reader does not claim another agent's screen. */
const HINT = /navigate.*(copy|submit)|Enter:submit/i;

/**
 * A row: its key, its radio, its label, and - after a run of spaces - whatever
 * it says about itself.
 *
 * The key is one character and not always a digit, which is the whole reason
 * this reader exists rather than a looser pattern in the general one.
 */
const ROW = /^([0-9a-zA-Z])\s+\(([○●◯⦿])\)\s+(.+)$/;

/** The scrollbar grok paints down the right of the block. */
const SCROLLBAR = /[█▉▊▋▌▍▎▏]+\s*$/;

/** Two spaces or more: a column boundary rather than a word gap. */
const LABEL_GAP = /\s{2,}/;

export function readGrokPicker(lines: string[]): PaneQuestion | undefined {
  // Only the framed lines are the prompt. Everything else on the pane is the
  // transcript above it and grok's own status bars below.
  const framed: string[] = [];
  for (const line of lines) {
    if (!LEFT_RULE.test(line)) continue;
    framed.push(line.replace(LEFT_RULE, '').replace(SCROLLBAR, '').trimEnd());
  }
  if (framed.length === 0) return undefined;
  if (!framed.some((l) => HINT.test(l))) return undefined;

  const options: PickerOption[] = [];
  const keys: string[] = [];
  let question: string | undefined;
  for (const line of framed) {
    const text = line.trim();
    if (!text || HINT.test(text)) continue;
    const m = text.match(ROW);
    if (!m) {
      // Above the rows, and the first thing said: the question. Anything after
      // them is grok's own footer, which the hint test has already taken.
      if (options.length === 0 && !question) question = text;
      continue;
    }
    const [label, ...rest] = m[3].split(LABEL_GAP);
    const detail = rest.join(' ').trim();
    options.push({
      label: label.trim(),
      detail: truncateDetail(detail),
      ...(isFreeText(label.trim()) ? { freeText: true } : {}),
    });
    keys.push(m[1]);
  }

  if (options.length === 0) return undefined;
  return {
    question,
    options,
    multiSelect: false,
    // Answered by the key on the row, which for grok is not the row's position.
    choiceInput: 'number',
    choiceKeys: keys,
  };
}
