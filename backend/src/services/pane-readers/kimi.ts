/**
 * Reading Kimi Code's prompts off the pane it draws them on.
 *
 * Kimi asks in two shapes and only one of them was ever readable. Its approval
 * prompt numbers its rows, so the general rule found them - though it lost the
 * row under the cursor until 0.3.105, because that cursor is U+25B6 and the
 * glyph list had a different triangle. Its trust prompt numbers nothing at all:
 *
 * ```
 *  ──────────────────────────────────────────
 *   Trust this folder?                          <- the question
 *   ↑↓ navigate · Enter select · Esc exit       <- how it is answered
 *
 *   /tmp/…/kimi-trust                           <- context, indented less
 *   Kimi Code loads project-level MCP servers
 *   only in trusted folders.
 *
 *    ❯ Trust this folder                        <- an option, and the cursor
 *      Enable project MCP servers. Remembered   <- its description
 *      for this folder.
 *
 *      Don't trust
 *      Exit Kimi Code. Asked again next launch.
 *  ──────────────────────────────────────────
 * ```
 *
 * Nothing there begins with a digit, so a wearer was shown `Trust this folder?`
 * and no way to answer it. The rows are reachable all the same - the hint line
 * says how - and this is what the `arrow` answering path was built for: walk
 * the pane's own cursor to the row and press Enter, which is how OpenCode's
 * permission prompt has been answered since 0.3.64.
 *
 * The layout is what is read, not the shape of any one row. Both prompts are
 * bounded by a rule, both put the question on top and the options at a deeper
 * indent than the prose between, and both mark the row the pane is sitting on.
 * A description belongs to the option above it because no blank line separates
 * them, which is also how the two are told apart from the context paragraphs -
 * those sit further left.
 */

import type { PaneQuestion, PickerOption } from './index';

/** The rule kimi frames a prompt with. */
const RULE = /^\s*[─-╿]{8,}\s*$/u;

/** The line that says how the prompt is answered. Both shapes draw one, and it
 *  is the surest sign that a prompt is what is on screen at all. */
const HINT = /[↑↓].*(select|navigate|choose)/i;

/** The glyph on the row the pane is sitting on. Kept in step with the list in
 *  `glasses-relay.ts` - kimi has used two of them. */
const CURSOR = /^(\s*)([❯▶›→▸])\s+/;

/** A numbered row, once the cursor is off it: `1. Approve once`. */
const NUMBER = /^(\d+)[.)]\s+/;

/** Rows a wearer cannot answer from the ring. */
const UNANSWERABLE = new Set(['Other', 'Type something', 'Type your own answer', 'Reject with feedback']);

export function readKimiPrompt(lines: string[]): PaneQuestion | undefined {
  const hint = lastIndex(lines, (l) => HINT.test(l));
  if (hint < 0) return undefined;

  // The prompt is what the rules enclose. The hint sits inside it, so the
  // bounds are the nearest rule each way from there.
  const top = lastIndex(lines.slice(0, hint), (l) => RULE.test(l));
  if (top < 0) return undefined;
  let bottom = lines.length;
  for (let i = hint + 1; i < lines.length; i++) {
    if (RULE.test(lines[i])) {
      bottom = i;
      break;
    }
  }
  const block = lines.slice(top + 1, bottom);

  // The question is the first thing in the block, and everything after it is
  // the prompt's own content. Scanning from the top instead read the question
  // as an option: kimi heads its approval prompt with the same glyph it marks
  // a row with.
  const questionAt = block.findIndex((l) => l.trim() && !RULE.test(l) && !HINT.test(l));
  if (questionAt < 0) return undefined;

  // The row the pane is sitting on, and with it the column every option's text
  // starts at. The LAST cursor in the block, for the same reason: the marker on
  // the question is not a cursor, and it comes first.
  const cursorAt = lastIndex(block, (l) => CURSOR.test(l));
  if (cursorAt <= questionAt) return undefined;
  const column = labelColumnOf(block[cursorAt]);

  const rows: Array<{ option: PickerOption; index: number; numbered: boolean }> = [];
  let paragraphStart = true;
  for (let i = questionAt + 1; i < block.length; i++) {
    const line = block[i];
    if (!line.trim()) {
      paragraphStart = true;
      continue;
    }
    if (HINT.test(line)) {
      paragraphStart = true;
      continue;
    }
    const bare = stripCursor(line);
    const indent = bare.length - bare.trimStart().length;
    const numbered = NUMBER.test(bare.trim());
    // A numbered row carries its own answer and is an option wherever it sits -
    // kimi draws those consecutively, with no blank line to start a paragraph
    // with. An unnumbered one is an option when it starts a paragraph at the
    // cursor's own column; the prose between sits further left, which is what
    // keeps the path and the explanation out.
    if (numbered || (paragraphStart && indent === column)) {
      rows.push({
        option: { label: bare.trim().replace(NUMBER, ''), detail: '' },
        index: i,
        numbered,
      });
      paragraphStart = false;
      continue;
    }
    const last = rows[rows.length - 1];
    // A description follows its option with no blank line between, so anything
    // reached without one belongs to the row above.
    if (last && !paragraphStart) last.option.detail = join(last.option.detail, line.trim());
    paragraphStart = false;
  }

  const kept = rows.filter((r) => !UNANSWERABLE.has(r.option.label));
  if (kept.length === 0) return undefined;

  const numbered = kept.every((r) => r.numbered);
  const selected = kept.findIndex((r) => r.index === cursorAt);

  return {
    question: questionOf(block, questionAt),
    options: kept.map((r) => r.option),
    multiSelect: false,
    // Numbered rows answer to their own digit, and a row dropped from the list
    // costs nothing there. An unnumbered one is answered by counting steps from
    // where the pane's cursor is, so the count has to be exact - and if the
    // cursor was on a row that went, it cannot be.
    ...(numbered
      ? { choiceInput: 'number' as const }
      : selected >= 0 && kept.length === rows.length
        ? { choiceInput: 'arrow' as const, choiceSelected: selected }
        : {}),
  };
}

/**
 * The question: the first line of the block, above the hint.
 *
 * Kimi puts it there in both shapes, which is why no question mark is looked
 * for - `Write this file?` has one and a Japanese prompt would not.
 */
function questionOf(block: string[], at: number): string | undefined {
  const line = block[at];
  return line ? stripCursor(line).trim() : undefined;
}

/** Where an option's own text begins, with the cursor and its space removed. */
function labelColumnOf(line: string): number {
  const bare = stripCursor(line);
  return bare.length - bare.trimStart().length;
}

/** The line with its cursor replaced by spaces, so columns still line up with
 *  the rows that have none. */
function stripCursor(line: string): string {
  const m = line.match(CURSOR);
  return m ? ' '.repeat(m[0].length) + line.slice(m[0].length) : line;
}

function join(head: string, tail: string): string {
  if (!head) return tail;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(head) ? head + tail : `${head} ${tail}`;
}

function lastIndex(lines: string[], match: (l: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (match(lines[i])) return i;
  }
  return -1;
}
