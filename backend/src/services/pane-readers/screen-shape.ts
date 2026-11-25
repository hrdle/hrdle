import { displayWidth } from '../../utils/display-width';
import {
  CJK_EDGE,
  CURSOR,
  dropSidePanel,
  isFreeText,
  joinWrapped,
  MAX_CHOICES,
  MAX_DETAIL_CHARS,
  stripCursor,
} from './shared';

/**
 * A waiting pane read by the shape of its screen rather than by a reader that
 * knows the agent: options are numbered or boxed rows, and the question is the
 * paragraph above them. The relay uses it for an agent with no reader of its
 * own, for the question text when a recorded call does not say which of its
 * tabs is in front, and - on an agent that has a reader - only for a permission
 * prompt, recognised by its wording. Let loose on any other screen of such an
 * agent it found a `grep` listing and called it a question.
 */

/**
 * One line of an option list, whoever drew it.
 *
 * Two numbering styles, because the agents do not agree: claude and codex
 * write `1. Yes`, kimi writes `[1] Yes`. The optional leading glyph is the
 * cursor on the selected row, and every agent picked a different one - `❯` from
 * claude, `→` from kimi, `›` from codex. herdr's `strip_ansi` removes colour
 * but leaves all of them alone, so they arrive here as themselves.
 *
 * Missing one is not a missing row, it is a WRONG row. Measured against codex
 * 0.146.0 on 2026-08-07: its trust prompt draws `› 1. Yes, continue` over
 * `  2. No, quit`, and with `›` unlisted the first line failed to match while
 * the second, having no cursor, matched fine. The glasses were handed a single
 * option reading `No, quit` - and answering it types `1`, which is `Yes,
 * continue`. On the one prompt where the wrong answer grants project-local
 * config, hooks and exec policies.
 *
 * Kept in step with `extractChoices` in `glasses/src/ws-client.ts`, which is
 * the same reading done against a live terminal buffer.
 */
const NUMBERED_OPTION = new RegExp(`^\\s*${CURSOR}?\\s*(?:\\d+[.)]|\\[\\d+\\])\\s*(.+)`);

/**
 * A checkbox row that carries no number at all.
 *
 * Kimi's multi-select draws exactly this - `   [ ] Apple`, four of them, and
 * not a digit anywhere on the screen even though `1-4` still works as a key.
 * `NUMBERED_OPTION` matched none of it, so a kimi multi-select produced no
 * choices at all; `refreshBlocked` then held the previous question rather than
 * replace it with an empty one, and the panel sat on question 1 while the pane
 * had moved to question 2. The wearer's next pick went to a question they were
 * never shown, which is the failure this whole path exists to prevent.
 *
 * Claude's multi-select rows are numbered *and* checkboxed (`1. [ ] Apple`),
 * so they match the numbered form first and keep their box in the capture -
 * the box is what tells the app this is a multi-select at all.
 */
const CHECKBOX_OPTION = new RegExp(`^\\s*${CURSOR}?\\s*(\\[[ xX*✓✔]\\]\\s*\\S.*)`);

/**
 * The rule a pane frames its content with, on the left of every line.
 *
 * opencode draws one - `┃` down the whole prompt - and it was enough on its own
 * to make this file blind to that agent: every pattern here anchors at the
 * start of a line and allows only spaces and a cursor glyph before the thing it
 * is looking for. A rule is neither, so nothing matched, and it would have
 * matched nothing even if opencode had numbered its options.
 *
 * Stripped rather than allowed for in each pattern: a left border is furniture,
 * not content, and the readers should not each have to know that.
 */
const LEFT_RULE = /^(\s*[│┃|┆┊╎┇┋║])+/;

/** A line with its framing removed. */
export function stripLeftRule(line: string): string {
  return line.replace(LEFT_RULE, '');
}

/**
 * The line under an option that says what it means.
 *
 * Kimi's AskUserQuestion puts a bare label on the numbered line and the
 * substance under it, indented past where the label starts:
 *
 * ```
 *     [1] 案 A (Recommended)
 *         現行の動詞列の構成を活かしつつ「スマホやG2から」を明示
 * →   [2] 案 B
 *         最短。操作できることを先に言い切る
 * ```
 *
 * Reading only the numbered lines sent a wearer `案A / 案B / 案C` - three
 * labels that name nothing, on a question whose whole content was in the lines
 * that were dropped. Recorded on the G2 on 2026-08-08 and unanswerable as
 * drawn.
 *
 * Recognised by indentation rather than by what it says: a continuation is
 * indented further than the label it belongs to, which the footer hints
 * (`↑↓ select …`, flush left) and a blank separator line are not. The
 * indentation is measured against where the *label* starts, not the line, so
 * the cursor glyph on the selected row does not change the answer.
 *
 * This is where the label starts within an option line, for that comparison.
 */
function labelColumn(line: string, label: string): number {
  const at = line.lastIndexOf(label);
  return at < 0 ? line.length : at;
}

/** Leading whitespace of a line, in characters. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** An option as the pane drew it: the row, and the lines under it that say
 *  what it means. Kept apart all the way to the item, because the picker draws
 *  them in different places. */
export interface ScrapedChoice {
  label: string;
  detail: string;
  /** The row opens a text field rather than answering. Kept, not dropped: the
   *  glasses answer it by dictation. */
  freeText?: boolean;
}

/** Extract `1. Yes` / `❯ 2. No` / `→ [1] Yes` / `[ ] Yes` style options, each
 *  with the description line under it when the agent draws one. */
export function extractChoiceRows(lines: string[]): ScrapedChoice[] {
  const rows: Array<{ label: string; detail: string; column: number }> = [];
  for (const raw of lines) {
    const line = stripLeftRule(raw);
    const m = line.match(NUMBERED_OPTION) ?? line.match(CHECKBOX_OPTION);
    if (m) {
      if (rows.length >= MAX_CHOICES) break;
      const label = dropSidePanel(m[1]).trim();
      rows.push({ label, detail: '', column: labelColumn(line, label) });
      continue;
    }
    const last = rows[rows.length - 1];
    if (!last) continue;
    // A blank line ends the block: what follows it belongs to the prompt's
    // furniture, not to the option above.
    if (!line.trim()) {
      last.column = Number.POSITIVE_INFINITY;
      continue;
    }
    // Aligned with the label, or further in. Kimi sets its description flush
    // with the label above it, so "further in than the label" would miss every
    // one of them; the footer hints sit far to the left of it either way.
    if (indentOf(line) < last.column) continue;
    last.detail = joinWrapped(last.detail, dropSidePanel(line).trim());
  }

  // Mostly marked on the label alone - `Other` is the text row whatever
  // description an agent hangs off it - but a couple only mean it at the foot
  // of the list, where the picker draws its own rather than where an agent
  // wrote one.
  return rows.map((r, i) => ({
    label: r.label,
    detail: truncate(r.detail, MAX_DETAIL_CHARS),
    ...(isFreeText(r.label, { last: i === rows.length - 1 }) ? { freeText: true } : {}),
  }));
}

/** The same options with each description written after its label, which is
 *  how a single line of text has to carry both. Kept for callers that have one
 *  line to spend rather than a screen. */
export function extractNumberedChoices(lines: string[]): string[] {
  return extractChoiceRows(lines).map((c) => (c.detail ? `${c.label} - ${c.detail}` : c.label));
}

/** Cut to `max` characters, marking that something was cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The question the pane is waiting on: the last `?`-terminated line, or the
 * permission prompt's "Do you want to …" line. Falls back to the last line that
 * actually says something (raw tail, unsummarized — display insurance only).
 *
 * "Says something" is the part opencode forced. Its prompt ends in neither a
 * question mark nor `Do you want to`, so the fallback ran - and every line of
 * that pane starts with a rule, several are nothing else, so the notification a
 * wearer got was one box-drawing character. A line with no letter and no digit
 * in it is furniture, and furniture is never the question.
 */
export function extractQuestionLine(lines: string[], before = lines.length): string | undefined {
  return findQuestion(lines, before).text;
}

/**
 * The question, and whether it was recognised or merely the last thing on
 * screen.
 *
 * The difference decides whether a notification exists at all. A pane herdr
 * calls `blocked` is not always asking: claude sits blocked between turns, and
 * the scrape then finds no question and no options, so the fallback returned
 * whatever the TUI had drawn at the bottom - and a waiting item was built from
 * it regardless. On 2026-08-07 that put `⏵⏵ auto mode on (shift+tab to cycle)`
 * on a wearer's face as a question, and it would not go away: dismissing it
 * only cleared that copy, and the next blocked flicker made another.
 *
 * The damage was not only the wrong words. A waiting item claims double-tap -
 * on the conversation screen it means "later" rather than "back" - so a
 * notification nobody asked for and nobody could clear left the wearer unable
 * to leave the screen. That is what `confident` exists to prevent: a guess is
 * still worth SHOWING when something real is already known to be waiting, but
 * it is never worth interrupting someone for.
 */
export function findQuestion(
  lines: string[],
  before = lines.length,
): { text?: string; confident: boolean } {
  const clean = lines
    .slice(0, before)
    .map((l) => stripCursor(stripLeftRule(l)).trim())
    .filter((l) => l.length > 0 && /[\p{L}\p{N}]/u.test(l));

  // A line that ends in a question mark is where the question ends. Where it
  // *starts* is further up whenever the pane was too narrow to hold it, and
  // taking the last line alone said so out loud: a wearer was asked
  // `うしますか?` on 2026-08-12 - the tail four characters of a question about
  // fourteen workspaces, wrapped over three rows at 54 columns. Read backwards
  // from the mark, the same way the fallback reads backwards from the bottom.
  for (let i = clean.length - 1; i >= 0; i--) {
    if (/[?？]\s*$/.test(clean[i])) {
      return { text: paragraphEndingAt(clean, i), confident: true };
    }
    // The permission prompt's own line, which opens a sentence rather than
    // closing one - so it is the start of what to read, not the end of it.
    if (/do you want to/i.test(clean[i])) {
      return { text: clean[i], confident: true };
    }
  }

  // Otherwise the paragraph above the options rather than the line above them.
  // A question long enough to matter is long enough to wrap, and a pane wraps
  // it wherever its width falls, so one line of it is whichever fragment
  // happened to be last. Codex's trust prompt arrived as `injection. Trusting
  // the directory allows project-local config, hooks, and exec policies to
  // load.` - the tail of a sentence whose beginning said what was being decided.
  return { text: tailParagraph(clean), confident: false };
}

/** The run of lines at the end of `clean`, joined - one paragraph as the pane
 *  laid it out, up to the blank line that separates it from what came before. */
function tailParagraph(clean: string[]): string | undefined {
  return paragraphEndingAt(clean, clean.length - 1);
}

/**
 * The paragraph whose last line is `end`, joined back into one.
 *
 * `clean` has already dropped blanks, so the paragraph break has to be found
 * another way: a line the pane wrapped continues the one above it, and a line
 * it started fresh does not. Length is the only signal left, and the honest
 * version of it is that a short line ends a paragraph.
 */
function paragraphEndingAt(clean: string[], end: number): string | undefined {
  if (end < 0 || end >= clean.length) return undefined;
  const out: string[] = [clean[end]];
  // The line directly above is where the wrap column is read off - it is the
  // one that certainly belongs to this paragraph and was certainly cut by the
  // column rather than by its author. Every line further up has to match that
  // width to join, which is what keeps an unrelated long line above the
  // paragraph out of it.
  let column = 0;
  for (let i = end - 1; i >= 0; i--) {
    const w = displayWidth(clean[i]);
    if (column === 0) {
      // Nothing this short was wrapped: the author stopped there. Also what
      // stops a menu of short rows being read as one long paragraph.
      if (w < MIN_WRAP_WIDTH) break;
      column = w;
    } else if (Math.abs(w - column) > wrapTolerance(clean[i])) {
      break;
    }
    out.unshift(clean[i]);
    if (out.length >= MAX_QUESTION_LINES) break;
  }
  return out.reduce(joinWrapped);
}

/**
 * Where the wrap column is, and how exactly a line has to hit it.
 *
 * The column used to be assumed - a flat 60 - and it was the pane's own width
 * that had been in mind. A question is drawn inside the picker's box, indented
 * and ruled, so the wrap falls well short of the pane: claude's picker in an
 * 80-column pane wraps at 54. Every line of the question reached that and none
 * of them reached 60, so the join never fired and a wearer was asked
 * `うしますか?` - the tail four characters of the sentence.
 *
 * How near a line has to come depends on what it is written in. A CJK row is
 * broken wherever the column falls and stops a character short of it at worst;
 * a Latin one is broken at a space, so it stops wherever the next word began -
 * up to a long word short of the column. One tolerance for both is wrong for
 * one of them: at 2 an English paragraph stops joining, and at 15 a CJK
 * paragraph starts swallowing the line above it.
 */
const MIN_WRAP_WIDTH = 40;
const CJK_WRAP_TOLERANCE = 2;
const LATIN_WRAP_TOLERANCE = 15;

function wrapTolerance(line: string): number {
  return CJK_EDGE.test(line) ? CJK_WRAP_TOLERANCE : LATIN_WRAP_TOLERANCE;
}

/** However wrapped, a question that takes more than this is not being read off
 *  a pair of glasses anyway. */
const MAX_QUESTION_LINES = 3;

/**
 * Where the option block starts, so the question can be looked for above it.
 *
 * A question mark is not a reliable marker and never was outside English.
 * Japanese asks with `ください` or a full-width `？` or nothing at all, so the
 * search fell through to "the last line that says something" - and on a live
 * pane the last line that says something is whatever the TUI drew at the
 * bottom. On 2026-08-07 a wearer was shown `❯ ちなみに録画情報を見てください`,
 * which was the line THEY had just typed into the input box, presented to them
 * as the agent's question. Another read the same day produced
 * `⏵⏵ auto mode on (shift+tab to cycle)`.
 *
 * The structure says it without knowing any language: an agent writes its
 * question, then its options under it. So the question is the last thing said
 * above the first option, and nothing below the first option can be it.
 */
export function optionBlockStart(lines: string[]): number {
  for (const [i, raw] of lines.entries()) {
    const line = stripLeftRule(raw);
    if (NUMBERED_OPTION.test(line) || CHECKBOX_OPTION.test(line)) return i;
  }
  return lines.length;
}

/**
 * What opencode is asking, from the two lines it says it in.
 *
 * ```
 *   ┃  △ Permission required
 *   ┃    → Edit fixture.txt
 * ```
 *
 * Neither line alone is the question: the first says only that there is one,
 * the second only names its object. The generic fallback would take the lower
 * of the two and put `→ Edit fixture.txt` on the glasses, which reads as
 * something already done rather than something being asked. Joined, they say
 * what a wearer needs to decide on.
 */
export function extractPermissionRequest(lines: string[]): string | undefined {
  const clean = lines.map((l) => stripLeftRule(l).trim());
  const bare = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  for (let i = clean.length - 1; i >= 0; i--) {
    if (!/permission required/i.test(clean[i])) continue;
    const parts: string[] = [];
    // A short window, because the option row is further down the same pane and
    // is made of words too. Nothing legitimate sits more than a line or two
    // below the marker.
    for (let j = i + 1; j < Math.min(clean.length, i + 5) && parts.length < 2; j++) {
      if (!/[\p{L}\p{N}]/u.test(clean[j])) continue;
      const heading = clean[j].startsWith('#');
      parts.push(bare(clean[j]));
      // A heading names a category rather than a thing - `# Shell command` -
      // and stopping there tells a wearer only that a command wants running,
      // not which one, when which one is the entire decision. So a heading
      // takes the line under it with it, and anything else stands alone.
      if (!heading) break;
    }
    const label = bare(clean[i]);
    return parts.length > 0 ? `${label}: ${parts.join(': ')}` : label;
  }
  return undefined;
}
