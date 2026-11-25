/**
 * The line Claude Code draws above its input box while a turn runs:
 *
 * ```
 * ✻ Propagating… (42s · ↓ 1.7k tokens)
 *   ⎿  Tip: Double-tap esc to rewind the code and/or
 *      conversation to a previous point in time
 *
 * ──────────────────────────────────            <- top rule of the input box
 * ❯
 * ──────────────────────────────────            <- bottom rule
 *   ⏵⏵ auto mode on · esc to interrupt
 * ```
 *
 * The verb, the elapsed time and the token count are published nowhere else:
 * the transcript is written a message at a time, so a turn spent thinking
 * looks from there like a turn that has stalled.
 *
 * Measured on Claude Code under herdr 0.9.5. The finished form of the same
 * line (`✻ Sautéed for 32s · done 8:32 AM`) has no ellipsis, which is what
 * keeps a turn that has ended from reading as one still running.
 */

const RULE = /^[\s─━]*[─━]{10,}[\s─━]*$/;
const SPINNER = /^([^\s●❯⎿])\s+(\S.*?…)\s*(?:\((.*)\))?\s*$/;
/** Key hints share the parentheses in some versions; they are not progress. */
const KEY_HINT = /^(?:esc|ctrl\+\S+|shift\+\S+|tab) to /;
/** A todo list hangs under the line; past this it is not the line's own block. */
const MAX_BLOCK_LINES = 20;

export interface ClaudeProgress {
  /** The spinner's own glyph, which Claude Code animates. */
  glyph: string;
  /** `Propagating…`, or the current todo's wording when there is a list. */
  label: string;
  /** `42s · ↓ 1.7k tokens`, without the key hints. */
  detail?: string;
}

/** The progress line in a plain-text screen, or null when no turn is running. */
export function parseClaudeProgress(screen: string): ClaudeProgress | null {
  const lines = screen.split('\n').map((l) => l.replace(/\r$/, ''));
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) {
      bottom = i;
      break;
    }
  }
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  // Upwards past the blank line and the indented block (a tip, the todo list)
  // to the first line that starts at the margin.
  for (let i = top - 1; i >= 0 && top - i <= MAX_BLOCK_LINES; i--) {
    const line = lines[i];
    if (line.trim() === '' || /^\s/.test(line)) continue;
    const m = line.match(SPINNER);
    if (!m) return null;
    const detail = (m[3] ?? '')
      .split('·')
      .map((p) => p.trim())
      .filter((p) => p && !KEY_HINT.test(p))
      .join(' · ');
    return { glyph: m[1], label: m[2], ...(detail ? { detail } : {}) };
  }
  return null;
}
