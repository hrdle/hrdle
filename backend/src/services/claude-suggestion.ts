import { claudeFooterLines } from './claude-footer';

/**
 * The prompt Claude Code suggests next, read off its input box.
 *
 * After a turn Claude Code may draw a suggested next prompt inside the empty
 * input box, faint, where Tab accepts it. Nothing else publishes it - the
 * transcript does not carry it - so the screen is the source, and it has to be
 * read with its attributes: the same words typed by a person are drawn at full
 * strength, and only the faint attribute (SGR 2) tells the two apart.
 *
 * ```
 * ────────────────────────────────            <- top rule of the input box
 * ❯ \e[2mnote.txt の中身を見せて\e[0m           <- every character faint
 * ────────────────────────────────            <- bottom rule
 *   ⏵⏵ auto mode on (shift+tab to cycle)       <- footer
 * ```
 *
 * Measured on Claude Code under herdr 0.9.5.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences are what is being read
const SGR = /\x1b\[([0-9;]*)m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what is being removed
const OTHER_ESCAPES = /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const RULE = /^[\s─━]*[─━]{10,}[\s─━]*$/;
const PROMPT = /^\s*❯[\s ]?/;

interface Run {
  text: string;
  faint: boolean;
}

/** A line's text in runs that share the faint attribute. */
function runsOf(line: string): Run[] {
  const runs: Run[] = [];
  let faint = false;
  let at = 0;
  const clean = line.replace(OTHER_ESCAPES, '');
  for (const m of clean.matchAll(SGR)) {
    if (m.index > at) runs.push({ text: clean.slice(at, m.index), faint });
    const params = m[1] === '' ? ['0'] : m[1].split(';');
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      // 38/48 carry a colour as further parameters, which are not attributes.
      if (p === '38' || p === '48') {
        i += params[i + 1] === '2' ? 4 : 2;
        continue;
      }
      if (p === '0' || p === '22') faint = false;
      else if (p === '2') faint = true;
    }
    at = m.index + m[0].length;
  }
  if (at < clean.length) runs.push({ text: clean.slice(at), faint });
  return runs;
}

const plain = (line: string) => runsOf(line).map((r) => r.text).join('');

/** The suggestion in an ANSI screen, or null when the box holds none. */
export function parseClaudeSuggestion(ansiScreen: string): string | null {
  const lines = ansiScreen.split('\n').map((l) => l.replace(/\r$/, ''));
  const text = lines.map(plain);
  if (!claudeFooterLines(text.join('\n'))) return null;

  let bottom = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (RULE.test(text[i])) {
      bottom = i;
      break;
    }
  }
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (RULE.test(text[i])) {
      top = i;
      break;
    }
  }
  if (top < 0 || bottom - top < 2) return null;
  if (!PROMPT.test(text[top + 1])) return null;

  const parts: string[] = [];
  for (let i = top + 1; i < bottom; i++) {
    const runs = runsOf(lines[i]);
    if (i === top + 1) {
      // Drop the prompt glyph, which is drawn at full strength.
      const lead = text[i].match(PROMPT)?.[0].length ?? 0;
      let skip = lead;
      while (skip > 0 && runs.length > 0) {
        const r = runs[0];
        if (r.text.length <= skip) {
          skip -= r.text.length;
          runs.shift();
        } else {
          runs[0] = { ...r, text: r.text.slice(skip) };
          skip = 0;
        }
      }
    }
    // One character typed at full strength means the box holds the person's
    // own words, not a suggestion.
    if (runs.some((r) => !r.faint && r.text.trim().length > 0)) return null;
    const piece = runs.map((r) => r.text).join('').trim();
    if (piece) parts.push(piece);
  }
  const joined = parts.reduce((acc, p) => {
    if (!acc) return p;
    // A wrapped Latin word boundary needs its space back; CJK does not.
    return /[\x21-\x7e]$/.test(acc) && /^[\x21-\x7e]/.test(p) ? `${acc} ${p}` : acc + p;
  }, '');
  return joined || null;
}
