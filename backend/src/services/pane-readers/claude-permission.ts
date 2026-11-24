import { joinWrapped, lastIndex } from './shared';

/**
 * Claude Code's permission prompt, read by its frame.
 *
 * ```
 * ──────────────────────────────────────────      <- solid rule: the top
 *  Bash command                                   <- what wants permission
 *  Create empty file made-by-claude.txt           <- detail, down to the question
 * ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *  touch made-by-claude.txt
 * ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 *  Do you want to proceed?                        <- the question, right above 1.
 *  ❯ 1. Yes
 *    2. Yes, and always allow access to
 *       /long/path from this project              <- a wrapped row
 *    4. No
 *
 *  Esc to cancel · Tab to amend                   <- the footer, last on screen
 * ```
 *
 * Measured on Claude Code under herdr 0.9.5 for Bash and Edit. A digit answers
 * a row at once. `Tab to amend` on a row opens a text field in it, which is how
 * "No" carries an instruction back to Claude.
 *
 * The question picker ends in `Enter to select`, and the folder trust prompt in
 * `Enter to confirm` with unnumbered rows, so neither matches here.
 */
export interface ClaudePermission {
  title: string;
  question: string;
  detail: string[];
  options: Array<{ label: string; description?: string }>;
  /** The row the pane's cursor is on: a walk to the amend field starts there. */
  cursor: number;
  amend: boolean;
}

const FOOTER = /^\s*esc to cancel\b/i;
const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.*)$/;
const SOLID_RULE = /^\s*─{8,}\s*$/;
const DASHED_RULE = /^\s*[╌┄┈-]{8,}\s*$/;
const TIP = /^\s*tip:/i;

/**
 * Whether `next` continues `prev` because the pane ran out of columns.
 *
 * Claude wraps at a word when it can, so a line is a continuation when the
 * first word of the next one would not have fitted after it. A path wider than
 * the pane is cut mid-word, which leaves the line exactly full.
 */
function wrapOf(prev: string, next: string, width: number): 'word' | 'cut' | undefined {
  if (prev.length >= width) return 'cut';
  const word = next.trim().split(/\s+/)[0] ?? '';
  return prev.length + 1 + word.length > width ? 'word' : undefined;
}

function join(prev: string, next: string, how: 'word' | 'cut'): string {
  return how === 'cut' ? prev + next.trim() : joinWrapped(prev, next.trim());
}

/** Lines rejoined where the pane wrapped them. */
function unwrap(lines: string[], width: number): string[] {
  const out: string[] = [];
  let raw = '';
  for (const line of lines) {
    const how = out.length > 0 ? wrapOf(raw, line, width) : undefined;
    if (how) out[out.length - 1] = join(out[out.length - 1], line, how);
    else out.push(line.trim());
    raw = line;
  }
  return out;
}

export function readClaudePermission(screen: string[]): ClaudePermission | undefined {
  const lines = screen.map((l) => l.replace(/\r$/, '').replace(/\s+$/, ''));
  const footer = lastIndex(lines, (l) => l.trim().length > 0);
  if (footer < 0 || !FOOTER.test(lines[footer])) return undefined;
  // On a narrow pane the picker's footer wraps and leaves `Esc to cancel` on a
  // line of its own, so the line above it is checked too.
  const above = lastIndex(lines.slice(0, footer), (l) => l.trim().length > 0);
  if (/enter to/i.test(lines[footer]) || (above >= 0 && /enter to/i.test(lines[above]))) return undefined;

  const first = lastIndex(lines.slice(0, footer), (l) => OPTION.exec(l)?.[2] === '1');
  if (first < 0) return undefined;
  const questionAt = lastIndex(lines.slice(0, first), (l) => l.trim().length > 0);
  if (questionAt < 0) return undefined;
  const question = lines[questionAt].trim();
  if (!/[?？]$/.test(question)) return undefined;

  const top = lastIndex(lines.slice(0, questionAt), (l) => SOLID_RULE.test(l));
  if (top < 0) return undefined;
  // Text stops one column short of the rule, which spans the pane.
  const width = lines[top].length - 1;

  const rows: string[] = [];
  let cursor = -1;
  let raw = '';
  for (const line of lines.slice(first, footer)) {
    const m = OPTION.exec(line);
    if (m && Number(m[2]) === rows.length + 1) {
      if (m[1]) cursor = rows.length;
      rows.push(m[3].trim());
      raw = line;
    } else if (line.trim() && rows.length > 0) {
      rows[rows.length - 1] = join(rows[rows.length - 1], line, wrapOf(raw, line, width) ?? 'word');
      raw = line;
    }
  }
  if (rows.length < 2) return undefined;

  const body = unwrap(
    lines.slice(top + 1, questionAt).filter((l) => l.trim() && !DASHED_RULE.test(l)),
    width,
  ).filter((l) => !TIP.test(l));
  const title = body.shift();
  if (!title) return undefined;

  return {
    title,
    question,
    detail: body,
    options: rows.map((row) => {
      const at = row.indexOf(' · ');
      return at < 0 ? { label: row } : { label: row.slice(0, at), description: row.slice(at + 3) };
    }),
    cursor: Math.max(cursor, 0),
    amend: /tab to amend/i.test(lines[footer]),
  };
}
