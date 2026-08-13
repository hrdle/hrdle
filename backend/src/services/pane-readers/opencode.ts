/**
 * Reading OpenCode's Confirm prompt off the pane it draws it on.
 *
 * It numbers its rows, which is the trap. Every other numbered list in this
 * codebase is answered by typing the number, and OpenCode's is not:
 *
 * ```
 *  ┃   次に着手するタスク   Confirm
 *  ┃  次に着手したいタスクのタイプを教えてください（複数選択可）。 (select all that apply)
 *  ┃  1. [✓] 現状のコードを調査する
 *  ┃     まず作業対象や目的をコードから洗い出して進めたい
 *  ┃  2. [ ] 機能を追加する
 *  ┃  ...
 *  ┃  5. [ ] Type your own answer
 *  ┃  ⇆ tab  ↑↓ select  enter toggle  esc dismiss
 * ```
 *
 * The footer says what the numbers do not: the rows are walked to and toggled,
 * and the digits are decoration. Until this reader the general numbered rule
 * matched it and served it with no `choiceInput`, which means "answer by the
 * number" - so a wearer who ticked four boxes had three arrive, in a different
 * combination. Recorded on 2026-08-13.
 *
 * **Which row the pane is on is painted, not written.** Every row is
 * `  N. [x] label` at the same indent; the one under the cursor differs only in
 * its background. So this reader is the one that needs the pane with its escape
 * sequences left on, and the registry hands it both.
 *
 * The list wraps at both ends - measured: seven presses of up, from the first
 * of five rows, lands on the fourth - so a walk cannot be anchored by pressing
 * up until it stops. Where the cursor is has to be carried, which is why
 * `choiceSelected` travels and the app tracks it from there.
 */

import type { PaneQuestion, PaneRead } from './index';
import { isFreeText, joinWrapped, type PickerOption, truncateDetail } from './shared';

/** The frame OpenCode draws down the left of a prompt. */
const LEFT_RULE = /^\s*┃\s?/;

/** The footer of the list itself. `enter toggle` is the whole point: Enter does
 *  not confirm here, it ticks the row the cursor is on. */
const HINT_LIST = /[↑↓].*select/i;

/** The footer of the screen `tab` opens, which has no options on it - the
 *  answers drawn back, and Enter. */
const HINT_REVIEW = /enter\s+submit/i;

/** A row: its number, its box, and its label. */
const ROW = /^(\d+)\.\s*\[([ xX✓✔])\]\s*(\S.*)/;

/** What finishes the prompt: `tab` to the review screen, then Enter.
 *
 * The review screen is not shown to the wearer. Claude's has two rows and is a
 * real decision; this one draws the answers back and offers Enter, so putting
 * it on the panel would be a screen that asks nothing. The two keystrokes are
 * split by the app, which sends any walk one key at a time. */
const SEND = '\t\r';

export function readOpenCodePicker(read: PaneRead): PaneQuestion | undefined {
  const framed = read.lines.filter((l) => LEFT_RULE.test(l)).map((l) => l.replace(LEFT_RULE, '').trimEnd());
  if (framed.length === 0) return undefined;

  const review = framed.findIndex((l) => HINT_REVIEW.test(l));
  if (review >= 0) return readReview(framed, review);
  if (!framed.some((l) => HINT_LIST.test(l))) return undefined;

  const options: PickerOption[] = [];
  let question: string | undefined;
  for (const line of framed) {
    const text = line.trim();
    if (!text || HINT_LIST.test(text)) continue;
    const m = text.match(ROW);
    if (m) {
      // The box travels on the label, the way claude's does: it is what tells
      // the app this is a multi-select at all (`looksMultiSelect`), and without
      // it the picker offers no send row - so a wearer could tick every box and
      // have no way to finish. It is also the only place the ticks are shown.
      options.push({ label: `[${m[2]}] ${m[3].trim()}`, detail: '' });
      continue;
    }
    const last = options[options.length - 1];
    // Under a row: what it says about itself. Above the first: the question,
    // and only the first line of it - the header above that is the prompt's
    // own title bar (`次に着手するタスク   Confirm`), which is a label rather
    // than a sentence and says nothing the question does not.
    if (last) last.detail = joinWrapped(last.detail, text);
    else question = text;
  }
  if (options.length === 0) return undefined;

  for (const o of options) o.detail = truncateDetail(o.detail);
  const marked = options.map((o) => (isFreeText(o.label) ? { ...o, freeText: true } : o));
  const selected = selectedRow(read.painted);

  return {
    question,
    options: marked,
    multiSelect: true,
    // Both travel or neither does: an item carrying options and no
    // `choiceInput` reads as a numbered one, and the digits do nothing here.
    ...(selected !== undefined
      ? { choiceInput: 'arrow' as const, choiceAxis: 'column' as const, choiceSelected: selected, choiceSend: SEND }
      : {}),
  };
}

/**
 * The screen `tab` opens: the answers drawn back, and one thing to press.
 *
 * Read rather than ignored because a read that finds nothing leaves whatever
 * the glasses already have - which here would be the list, whose rows the
 * review screen does not answer to.
 */
function readReview(framed: string[], hintAt: number): PaneQuestion | undefined {
  const body = framed
    .slice(0, hintAt)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== 'Review');
  return {
    question: body[body.length - 1],
    options: [{ label: 'Submit', detail: '' }],
    multiSelect: false,
    // A walk of no steps and Enter, which is what this screen takes.
    choiceInput: 'arrow',
    choiceAxis: 'column',
    choiceSelected: 0,
  };
}

/** Colour a cell is painted on, as the last background named before it. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design.
const SGR_BG = /\x1b\[[0-9;]*?48;2;(\d+;\d+;\d+)/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design.
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * Which row the pane's cursor is on, from the one painted unlike the others.
 *
 * The baseline is the majority rather than a fixed colour: the highlight is a
 * theme's, and a theme is a thing a user picks. One row differing is the
 * cursor; none differing, or several, is a frame this reader has not seen, and
 * a guess there is a walk to the wrong row.
 */
function selectedRow(painted: string[] | undefined): number | undefined {
  if (!painted) return undefined;
  const rows: { at: number; bg: string }[] = [];
  for (const line of painted) {
    const plain = line.replace(SGR, '').replace(LEFT_RULE, '').trim();
    if (!ROW.test(plain)) continue;
    // The background in force where the row's own text begins - the frame and
    // the padding before it carry the panel's, not the row's.
    const at = line.indexOf(plain.slice(0, 2));
    const bg = line.slice(0, at < 0 ? line.length : at + 1).match(new RegExp(SGR_BG.source, 'g'))?.at(-1);
    const value = bg?.match(SGR_BG)?.[1];
    if (!value) return undefined;
    rows.push({ at: rows.length, bg: value });
  }
  if (rows.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.bg, (counts.get(r.bg) ?? 0) + 1);
  const odd = rows.filter((r) => (counts.get(r.bg) ?? 0) === 1);
  return odd.length === 1 ? odd[0].at : undefined;
}
