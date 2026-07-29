import { describe, expect, test } from 'bun:test';
import { buildSttPrompt } from '../stt-prompt';

/**
 * The prompt is the only thing telling Whisper that `herdr` is a word and that
 * 「2脚ロボ開発」 is a name. It is also capped, so what gets dropped when it is
 * full is the part worth pinning: names are unguessable, glossary terms are not.
 */
describe('buildSttPrompt', () => {
  test('names come first, since the glossary cannot cover them', () => {
    const prompt = buildSttPrompt(['グラス開発', '2脚ロボ開発'], ['ペイン']);
    expect(prompt).toBe('グラス開発、2脚ロボ開発、ペイン');
  });

  test('a name repeated as a title and a label is said once', () => {
    expect(buildSttPrompt(['cchub-work-2', 'CCHub-Work-2'], [])).toBe('cchub-work-2');
  });

  test('blank names are skipped rather than left as empty slots', () => {
    expect(buildSttPrompt(['', '   ', 'life'], [])).toBe('life');
  });

  test('no names and no glossary means no prompt at all', () => {
    // The caller sends nothing rather than an empty `prompt` field.
    expect(buildSttPrompt([], [])).toBe('');
  });

  test('the cap drops whole terms, never half of one', () => {
    const titles = ['あ'.repeat(180)];
    const prompt = buildSttPrompt({ titles }, ['ペイン', 'ワークスペース']);
    // 180 + 1 + 3 fits ペイン; ワークスペース would exceed 190 and is left out
    // whole — half a word biases nothing.
    expect(prompt).toBe(`${titles[0]}、ペイン`);
  });

  test('the words the user says outrank the workspace labels', () => {
    // The first cut spent the budget on names and dropped `リリース`, which is
    // said ten times a day, to keep a label that is said approximately never.
    const prompt = buildSttPrompt(
      { titles: ['グラス開発'], labels: ['い'.repeat(180)] },
      ['リリース'],
    );
    expect(prompt).toBe('グラス開発、リリース');
  });

  test('a name too long to fit does not block the shorter ones behind it', () => {
    const prompt = buildSttPrompt(['い'.repeat(200), 'life'], []);
    expect(prompt).toBe('life');
  });

  test('a full workspace list does not push out the words that get misheard', () => {
    // This is the regression: the first cut listed names first, and thirteen
    // workspaces ate the budget before `リリース` — the word reported as being
    // misheard several times a day — ever got in.
    const labels = [
      'hrdle', 'cchub-work-3', 'cchub-work-1', 'cchub-work-2', 'wheel-leg-bot',
      'life', 'linux', 'pixel-customrom', 'repos', 'lifestyle-app-work-1',
    ];
    const prompt = buildSttPrompt({ titles: ['グラス開発', '2脚ロボ開発'], labels });
    for (const term of ['リリース', 'マージ', 'リベース', 'ペイン']) {
      expect(prompt).toContain(term);
    }
    expect(prompt).toContain('2脚ロボ開発');
  });

  test('the whole prompt stays inside the cap', () => {
    const titles = Array.from({ length: 40 }, (_, i) => `ワークスペース名前${i}`);
    expect(buildSttPrompt({ titles }).length).toBeLessThanOrEqual(190);
  });
});
