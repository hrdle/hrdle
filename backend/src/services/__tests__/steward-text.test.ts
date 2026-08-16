import { describe, expect, it } from 'bun:test';
import { GLASSES_PAGE_WIDTH, fitToPage } from '../steward-text';
import { displayWidth } from '../glasses-relay';

const ja = (n: number) => 'あ'.repeat(n);

describe('fitToPage', () => {
  it('leaves a text that fits alone', () => {
    const fitted = fitToPage('ビルドが通りました', 'diff here');
    expect(fitted).toEqual({ text: 'ビルドが通りました', detail: 'diff here', spilled: false });
  });

  it('cuts at a sentence end when there is one late enough, and loses nothing', () => {
    const long = `${ja(150)}。${ja(100)}`;
    const fitted = fitToPage(long);
    expect(fitted.spilled).toBe(true);
    expect(fitted.text).toBe(`${ja(150)}。`);
    expect(displayWidth(fitted.text)).toBeLessThanOrEqual(GLASSES_PAGE_WIDTH);
    expect(`${fitted.text}${fitted.detail}`).toBe(long);
  });

  it('keeps a detail the caller wrote, below the overflow', () => {
    const fitted = fitToPage(`${ja(150)}。${ja(100)}`, 'the reasoning');
    expect(fitted.detail).toBe(`${ja(100)}\n\nthe reasoning`);
  });

  it('marks a mid-sentence cut, and does not take an early sentence end', () => {
    // The only full stop is in the first few characters, so cutting there would
    // leave a fragment where a page was asked for.
    const fitted = fitToPage(`短い。${ja(400)}`);
    expect(fitted.text.endsWith('…')).toBe(true);
    expect(displayWidth(fitted.text)).toBeLessThanOrEqual(GLASSES_PAGE_WIDTH);
  });

  it('counts half-width text at half a column', () => {
    const ascii = 'a'.repeat(GLASSES_PAGE_WIDTH);
    expect(fitToPage(ascii).spilled).toBe(false);
    expect(fitToPage(`${ascii}b`).spilled).toBe(true);
  });

  it('does not split a surrogate pair', () => {
    const fitted = fitToPage('\u{20BB7}'.repeat(400));
    expect(fitted.text).not.toContain('�');
    expect([...fitted.text].every((ch) => ch === '\u{20BB7}' || ch === '…')).toBe(true);
  });
});
