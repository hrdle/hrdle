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

export interface PickerOption {
  label: string;
  detail: string;
}

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
 */
const CHIP = /^\s*[☐☑✅✓✔]\s*\S/;

/** An option row: `1.` / `2)` / `[1]`, with the cursor glyph claude marks the
 *  current row with. Bounded by the frame, so it does not have to be careful. */
const OPTION = /^\s*[❯>]?\s*(?:\d+[.)]|\[\d+\])\s*(.+)/;

/** A checkbox row of a multi-select, which claude numbers as well as boxes. */
const BOXED = /^\s*[❯>]?\s*(?:\d+[.)]\s*)?(\[[ xX*✓✔]\])\s*(\S.*)/;

/**
 * Rows a wearer must not be offered.
 *
 * The first three open a text field, and the ring has no keyboard - a row whose
 * Enter does nothing visible. The rest belong to the picker rather than to the
 * question: a call carrying several questions draws a tab each and moves
 * between them with rows of its own, and those were what a wearer answered two
 * questions of three with. Filtering them leaves the front tab's own options
 * holding their own numbers, which is what a digit answers.
 */
const UNANSWERABLE = new Set([
  'Type something',
  'Chat about this',
  'Other',
  'Type your own answer',
  'Next',
  'Back',
  'Submit answers',
  'Submit answer',
  'Cancel',
]);

function isUnanswerable(label: string): boolean {
  return UNANSWERABLE.has(
    label
      .replace(/^\[[ xX*✓✔]\]\s*/, '')
      .trim()
      .replace(/[.:：]$/, ''),
  );
}

/**
 * A panel drawn level with the options, to their right.
 *
 * The option and the panel's border share a row, so everything after the
 * option's own text belongs to neither. Recognised by the gap in front of it
 * rather than by the characters alone: a rule drawn tight against a word is
 * part of the word, and two spaces before a border is a column boundary.
 */
const SIDE_PANEL = /\s{2,}[\u2500-\u257F+|].*$/u;

/** The rule the picker draws above the chips and below the options. */
const RULE = /^\s*[\u2500-\u257F\u2014-]{8,}\s*$/u;

/** A description under an option is indented past where the label starts. */
const MAX_DETAIL_CHARS = 120;

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
      const label = raw.replace(SIDE_PANEL, '').trim();
      if (!label) continue;
      if (firstOptionAt < 0) firstOptionAt = i;
      labelColumn = line.length - line.trimStart().length;
      options.push({ label, detail: '' });
      continue;
    }
    // Under an option and indented past it: the description claude draws for
    // the row above. Anything to the left of the label is the frame's own
    // furniture (`Notes: press n to add notes` sits far to the right, but a
    // blank line ends the run before it can be reached).
    const last = options[options.length - 1];
    if (!last || firstOptionAt < 0) continue;
    if (!line.trim()) {
      labelColumn = Number.POSITIVE_INFINITY;
      continue;
    }
    if (line.length - line.trimStart().length <= labelColumn) continue;
    const text = line.replace(SIDE_PANEL, '').trim();
    if (text) last.detail = join(last.detail, text);
  }

  const answerable = options.filter((o) => !isUnanswerable(o.label));
  if (answerable.length === 0) return undefined;

  for (const o of answerable) {
    if (o.detail.length > MAX_DETAIL_CHARS) o.detail = `${o.detail.slice(0, MAX_DETAIL_CHARS - 1)}…`;
  }

  return {
    question: questionOf(block.slice(0, firstOptionAt < 0 ? block.length : firstOptionAt)),
    options: answerable,
    multiSelect: answerable.some((o) => /^\[[ xX*✓✔]\]/.test(o.label)),
  };
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
  const text = before.map((l) => l.replace(SIDE_PANEL, '').trim()).filter((l) => l.length > 0 && !RULE.test(l));
  if (text.length === 0) return undefined;
  return text.slice(-MAX_QUESTION_LINES).reduce(join);
}

/**
 * Rejoin two rows the pane wrapped. A terminal breaks latin text at a space,
 * which the break consumes, so the halves need one put back; it breaks Japanese
 * wherever the column runs out, and a space there invents one never written.
 */
function join(head: string, tail: string): string {
  if (!head) return tail;
  if (!tail) return head;
  // Judged by the character the break landed after, not by both sides: a row
  // ending `グロサリー + ` was wrapped at a space that the trim then ate, and
  // testing the far side as well made the `+` and the `辞` meet with nothing
  // between them.
  return cjkSeam(head) ? head + tail : `${head} ${tail}`;
}

const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー、。「」『』（）？]/u;

function cjkSeam(before: string): boolean {
  return CJK_EDGE.test(before.slice(-1));
}

function lastIndex(lines: string[], match: (l: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (match(lines[i])) return i;
  }
  return -1;
}
