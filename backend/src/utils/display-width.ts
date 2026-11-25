/**
 * Display columns, counting East Asian wide characters as two, so mixed
 * Japanese and English can be clamped to what a G2 page or a pane row holds.
 */

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

/** Clamp to `max` display columns, appending `…` when truncated. */
export function clampDisplayWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > max - 1) break; // reserve a column for …
    out += ch;
    w += cw;
  }
  return `${out.trimEnd()}…`;
}
