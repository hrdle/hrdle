/**
 * What every pane reader needs, in one place.
 *
 * Each agent draws its prompt differently enough to deserve a reader of its
 * own - that is the whole design - but the things a reader has to *know* are
 * mostly the same, and were being learned separately. Four copies of "which row
 * opens a text field" is what prompted this: opencode's wording had to be added
 * to three of them the day it was discovered, and the fourth was found by a
 * failing test rather than by anyone remembering it existed.
 *
 * The rule for what belongs here: knowledge about agents in general (what a
 * cursor glyph is, what a text-entry row is called, how a terminal breaks a
 * line), not about any one agent's layout. A reader's own frame - claude's
 * chip and footer, kimi's rule and indent, grok's radio - stays in its file,
 * because that is the part that is genuinely its own.
 */

/** One option as a reader found it: the row, what it says about itself, and
 *  whether picking it opens a text field rather than answering. */
export interface PickerOption {
  label: string;
  detail: string;
  freeText?: boolean;
}

/**
 * The glyph an agent marks the current row with.
 *
 * Missing one is not a missing row, it is a WRONG row: the row that fails to
 * match is the one the pane is sitting on, so the list arrives one short and
 * every key after it answers a different option. That has cost two incidents -
 * codex's `›` on a trust prompt (2026-08-07) and kimi's `▶` on an approval
 * prompt (2026-08-12), the second of which would have approved a write for a
 * wearer who chose Reject.
 *
 * Generous on purpose, and cheap to be: a glyph no agent uses matches no line,
 * while a missing one silently rewrites an answer.
 */
export const CURSOR_GLYPHS = '❯›»❭❱⟩>*→‣▸▶▷►◆◇•·';

const CURSOR_CLASS = `[${CURSOR_GLYPHS}]`;

/** A leading cursor and the space after it. The space matters: `>` opens a
 *  quoted line and `→` sits inside sentences, and neither is a marker there. */
const LEADING_CURSOR = new RegExp(`^\\s*${CURSOR_CLASS}\\s+`);

/** The cursor pattern, for a reader building a row matcher of its own. */
export const CURSOR = CURSOR_CLASS;

/** The line with its leading marker removed. */
export function stripCursor(line: string): string {
  return line.replace(LEADING_CURSOR, '');
}

/** The same, keeping the columns: the marker becomes spaces, so a row with one
 *  still lines up with the rows that have none. */
export function blankCursor(line: string): string {
  const m = line.match(LEADING_CURSOR);
  return m ? ' '.repeat(m[0].length) + line.slice(m[0].length) : line;
}

/**
 * The rows that open a text field rather than answering.
 *
 * Every agent draws one and every one calls it something else. They are kept
 * and marked rather than dropped: the ring cannot type into a field but the
 * microphone can, and it is the row a wearer wants when none of the options
 * fit.
 */
const FREE_TEXT_LABELS = new Set([
  'Type something', // claude
  'Other', // kimi
  'Reject with feedback', // kimi - refusing with a reason is a thing to say
  'Type your answer here', // grok
  'Type your own answer', // opencode
]);

/**
 * The same, but only where the picker puts its own.
 *
 * `Chat about this` is claude's, drawn below the closing rule at the foot of
 * every question - so a row saying it anywhere else is a row an agent wrote,
 * and the wording is ordinary enough to be written. Measured: a question about
 * this very behaviour listed `Chat about this` as its third option, and the
 * wearer's tap opened the microphone instead of ticking the box.
 *
 * The position is the whole of the difference, which is why the label alone
 * cannot carry it.
 */
const TRAILING_FREE_TEXT_LABELS = new Set([
  'Chat about this', // claude
]);

/**
 * The rows that belong to the picker rather than to any question.
 *
 * A call carrying several questions draws a tab each and moves between them
 * with rows of its own, and those were what a wearer answered two questions of
 * three with. Dropping them leaves each question's own options holding their
 * own keys.
 */
const FURNITURE_LABELS = new Set([
  'Next',
  'Back',
  'Submit',
  'Submit answers',
  'Submit answer',
  'Cancel',
]);

/**
 * A label down to the words in it.
 *
 * The same row arrives in several dresses: claude writes `Type something.` in a
 * single-pick list and `[ ] Type something` in a multi-select, while kimi's
 * `Other` becomes `Other:` the moment it is the field being typed into.
 * Matching literally caught the first and missed the rest.
 */
export function bareLabel(label: string): string {
  return label
    .replace(/^\[[ xX*✓✔]\]\s*/, '')
    .trim()
    .replace(/[.:：]$/, '');
}

/**
 * Whether picking this row opens a field rather than answering.
 *
 * `at` is where the row sits in the list. A reader that does not pass it gets
 * the labels that mean the same wherever they are drawn, and none of the ones
 * that only mean it at the foot of the picker - which is the right answer for
 * an agent that draws no such row at all.
 */
export function isFreeText(label: string, at?: { last: boolean }): boolean {
  const bare = bareLabel(label);
  if (TRAILING_FREE_TEXT_LABELS.has(bare)) return at?.last === true;
  return FREE_TEXT_LABELS.has(bare);
}

export function isFurniture(label: string): boolean {
  return FURNITURE_LABELS.has(bareLabel(label));
}

/**
 * Rejoin two rows the pane wrapped.
 *
 * A terminal breaks latin text at a space, which the break then consumes, so
 * the halves need one put back; it breaks Japanese wherever the column runs
 * out - mid-word, mid-phrase - and a space there invents one that was never
 * written.
 *
 * Judged by the character the break landed after rather than by both sides: a
 * row ending `グロサリー + ` was wrapped at a space the trim then ate, and
 * testing the far side as well made the `+` and the `辞` meet with nothing
 * between them.
 */
export function joinWrapped(head: string, tail: string): string {
  if (!head) return tail;
  if (!tail) return head;
  return CJK_EDGE.test(head.slice(-1)) ? head + tail : `${head} ${tail}`;
}

/** A character that only CJK text is written with. A line ending in one was
 *  broken by the column rather than at a space, and a line containing one is
 *  wrapped that way throughout. */
export const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー、。「」『』（）？]/u;

/** However wrapped, a description longer than this is not read off a pair of
 *  glasses - and the server clamps it again to the lines it will actually get. */
export const MAX_DETAIL_CHARS = 120;

export function truncateDetail(text: string, max = MAX_DETAIL_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The last line matching, searched from the bottom - which is where a prompt
 *  is, and where a reader should look first. */
export function lastIndex(lines: string[], match: (l: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (match(lines[i])) return i;
  }
  return -1;
}

/**
 * A panel drawn level with the options, to their right.
 *
 * Claude Code puts a preview panel beside its list, so an option and the
 * panel's border share a row and everything after the option's own text belongs
 * to neither. Recognised by the gap in front of it rather than by the
 * characters alone: a rule drawn tight against a word is part of the word, and
 * two spaces before a border is a column boundary.
 */
const SIDE_PANEL = /\s{2,}[─-╿+|].*$/u;

export function dropSidePanel(text: string): string {
  return text.replace(SIDE_PANEL, '');
}

/** A horizontal rule: furniture, never content. */
export const RULE = /^\s*[─-╿—-]{8,}\s*$/u;
