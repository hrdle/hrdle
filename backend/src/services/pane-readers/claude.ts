import type { PickerOption } from './shared';
import {
  blankCursor,
  CURSOR,
  dropSidePanel,
  isFreeText,
  isFurniture,
  joinWrapped,
  lastIndex,
  RULE,
  truncateDetail,
} from './shared';
/**
 * Reading Claude Code's question picker off the pane it is drawn on.
 *
 * The reader this replaces looked for a shape rather than for a screen: a run
 * of lines beginning `1.`, `2.`, `3.` somewhere near the bottom. Every agent
 * numbers things, and so does every agent's *output* - so it found menus in a
 * `grep` listing (`71` / `const INFO_TTL_MS = 5 * 60_000;`, offered to a wearer
 * on 2026-08-12) and in Claude's own prose, which lists options in sentences
 * all the time and had four of them on screen the same afternoon with nothing
 * being asked at all.
 *
 * Claude's picker draws its own frame, and the frame is what this reads:
 *
 * ```
 * ────────────────────────────────────────────────
 *  ☐ 認証情報                                        <- a chip per question
 *
 * ルータ管理画面（admin）のパスワードをどう渡しますか？   <- the question
 *
 *  1. vaultに自分で保存（推奨）    ┌──────────────┐    <- options, and a preview
 *  2. チャットで直接教える         │ No preview   │       panel sharing their rows
 * ❯3. ルータ操作は中止             └──────────────┘
 *                                  Notes: press n to add notes
 * ────────────────────────────────────────────────
 *   Chat about this
 * Enter to select · ↑/↓ to navigate · Esc to cancel   <- the footer
 * ```
 *
 * Nothing that is not between a chip and that footer is an option, which is
 * the whole of the improvement: prose cannot forge either, and a listing has
 * neither. Three separate patches this file replaces - a side-panel stripper, a
 * tab-furniture filter, a full-width question mark - fall out of reading the
 * frame instead of the rows.
 *
 * Where the record can be read it still wins (`agent-question.ts`): it carries
 * the descriptions in full rather than as the screen truncated them. This is
 * what answers when it cannot, which since Claude Code 2.1.227 is every
 * question that has not been answered yet.
 */

export interface ClaudePicker {
  /** The question as the pane wrapped it, rejoined. */
  question?: string;
  options: PickerOption[];
  /** Rows carry a checkbox: answering means space-then-enter, not one digit. */
  multiSelect: boolean;
}

/**
 * The footer the picker always draws, and nothing else does.
 *
 * Matched on the two fixed phrases rather than the whole line: the middle of it
 * changes with what the question offers (`n to add notes` appears only when
 * notes are enabled), and the tail is `Esc to cancel` or a variant.
 */
const FOOTER = /enter to select/i;

/**
 * A tab chip: one per question in the call, `☐` unanswered and `☑` answered.
 *
 * Present for a single question too - a call with one question draws one chip -
 * so it is a reliable opening bracket. A permission prompt has none, which is
 * correct: that is a different screen and `extractPermissionRequest` owns it.
 *
 * The leading arrow is not optional decoration. A multi-select adds a `✔ Submit`
 * tab beside the question's own, and a strip with two tabs is drawn with the
 * keys that move between them:
 *
 * ```
 * ←  ☐ 機能選択  ✔ Submit  →
 * ```
 *
 * Anchored at the glyph alone, that line is not a chip, the block has no
 * opening bracket, and the reader answers "not this screen" for every
 * multi-select there has ever been - so no options reached the glasses and no
 * item was raised at all. Measured against Claude Code 2.1.228.
 */
const CHIP = /^\s*(?:[←→]\s+)?[☐☑✅✓✔]\s*\S/;

/** An option row: `1.` / `2)` / `[1]`, with the cursor glyph claude marks the
 *  current row with. Bounded by the frame, so it does not have to be careful. */
const OPTION = new RegExp(`^\\s*${CURSOR}?\\s*(?:\\d+[.)]|\\[\\d+\\])\\s*(.+)`);

/** A checkbox row of a multi-select, which claude numbers as well as boxes. */
const BOXED = new RegExp(`^\\s*${CURSOR}?\\s*(?:\\d+[.)]\\s*)?(\\[[ xX*✓✔]\\])\\s*(\\S.*)`);









/** However wrapped, a question longer than this is not read off glasses. */
const MAX_QUESTION_LINES = 4;

/**
 * The picker on this pane, if one is on it.
 *
 * `undefined` means "not this screen" and is the answer for every pane that is
 * not showing a question - which is nearly all of them, nearly all the time,
 * and is the answer the reader this replaces would not give.
 */
export function readClaudePicker(lines: string[]): ClaudePicker | undefined {
  const footer = lastIndex(lines, (l) => FOOTER.test(l));
  if (footer < 0) return undefined;
  const chip = lastIndex(lines.slice(0, footer), (l) => CHIP.test(l));
  if (chip < 0) return undefined;

  const block = lines.slice(chip + 1, footer);
  const options: PickerOption[] = [];
  let firstOptionAt = -1;
  let labelColumn = 0;

  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (RULE.test(line)) continue;
    const boxed = line.match(BOXED);
    const plain = boxed ? null : line.match(OPTION);
    if (boxed || plain) {
      const raw = boxed ? `${boxed[1]} ${boxed[2]}` : (plain?.[1] ?? '');
      const label = dropSidePanel(raw).trim();
      if (!label) continue;
      if (firstOptionAt < 0) firstOptionAt = i;
      // With the cursor blanked rather than stripped, so the marked row reports
      // the same column as the rows that have none - it is drawn at the left
      // edge and they are indented to clear it.
      labelColumn = indentOf(blankCursor(line));
      options.push({ label, detail: '' });
      continue;
    }
    // Under an option and no further left than it: the description claude draws
    // for the row above. Anything to the left of the label is the frame's own
    // furniture (`Notes: press n to add notes` sits far to the right, but a
    // blank line ends the run before it can be reached).
    //
    // Level with the label counts. A single-pick list indents its descriptions
    // past the label text, but a multi-select puts them at the row's own left
    // edge, under the checkbox - so "strictly further right" dropped the
    // description of every row but the first.
    const last = options[options.length - 1];
    if (!last || firstOptionAt < 0) continue;
    if (!line.trim()) {
      labelColumn = Number.POSITIVE_INFINITY;
      continue;
    }
    if (indentOf(line) < labelColumn) continue;
    const text = dropSidePanel(line).trim();
    // The button a multi-select is finished with sits under the last row, at the
    // indent a description has, and reads as one: `Type something — Submit`.
    if (!text || isFurniture(text)) continue;
    last.detail = joinWrapped(last.detail, text);
  }

  const answerable = options
    .filter((o) => !isFurniture(o.label))
    .map((o) => (isFreeText(o.label) ? { ...o, freeText: true } : o));
  if (answerable.length === 0) return undefined;

  for (const o of answerable) {
    o.detail = truncateDetail(o.detail);
  }

  return {
    question: questionOf(block.slice(0, firstOptionAt < 0 ? block.length : firstOptionAt)),
    options: answerable,
    multiSelect: answerable.some((o) => /^\[[ xX*✓✔]\]/.test(o.label)),
  };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The question, from the lines between the chip and the first option.
 *
 * Everything there is the question - the frame said so - which is why no
 * question mark is looked for. The reader this replaces searched for one, and
 * so answered `unknown` for `どう渡しますか？`: it listed the ASCII mark and not
 * the full-width one, and a Japanese question ends in the latter as often as
 * not.
 */
function questionOf(before: string[]): string | undefined {
  const text = before.map((l) => dropSidePanel(l).trim()).filter((l) => l.length > 0 && !RULE.test(l));
  if (text.length === 0) return undefined;
  return text.slice(-MAX_QUESTION_LINES).reduce(joinWrapped);
}






