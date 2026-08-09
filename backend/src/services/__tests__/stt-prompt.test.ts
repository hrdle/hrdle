import { describe, expect, test } from 'bun:test';
import { buildSttPrompt, sessionPromptTerms } from '../stt-prompt';

/**
 * The prompt is the only thing telling Whisper that `herdr` is a word and that
 * `ペイン` is not `ペイント`. It is also capped, so what gets dropped when it is
 * full is the part worth pinning - which is why what goes in it is now said
 * deliberately (a session's own words, the shared list) rather than scraped
 * from workspace labels (#210).
 */
describe('buildSttPrompt', () => {
  test("the speaking session's own words come first", () => {
    const prompt = buildSttPrompt({ session: ['音声認識', 'Groq'] }, ['ペイン']);
    expect(prompt).toBe('音声認識、Groq、ペイン');
  });

  test('the shared words sit between the session and the glossary', () => {
    // Someone typed the shared list on purpose; the glossary is only our guess
    // at the same thing.
    const prompt = buildSttPrompt({ session: ['音声認識'], shared: ['確定申告'] }, ['ペイン']);
    expect(prompt).toBe('音声認識、確定申告、ペイン');
  });

  test('a term repeated across the groups is said once', () => {
    expect(buildSttPrompt({ session: ['Groq'], shared: ['groq'] }, [])).toBe('Groq');
  });

  test('blank terms are skipped rather than left as empty slots', () => {
    expect(buildSttPrompt({ session: ['', '   ', 'life'] }, [])).toBe('life');
  });

  test('nothing to say means no prompt at all', () => {
    // The caller sends nothing rather than an empty `prompt` field.
    expect(buildSttPrompt({}, [])).toBe('');
  });

  test('the cap drops whole terms, never half of one', () => {
    const session = 'あ'.repeat(93);
    const prompt = buildSttPrompt({ session: [session] }, ['ペイン', 'い'.repeat(100)]);
    // 93 + 1 + 3 = 97 for ペイン; the 100-character term would take the line
    // past 190 and is left out whole.
    expect(prompt).toBe(`${session}、ペイン`);
  });

  test('a term too long to fit does not block the shorter ones behind it', () => {
    expect(buildSttPrompt({ session: ['い'.repeat(200), 'life'] }, [])).toBe('life');
  });

  test('the contributed groups cannot take more than half the budget', () => {
    // The #210 failure mode, reproduced with the group that replaced the one
    // that caused it: a session naming everything it might ever say must not
    // cost the words misheard in every session.
    const session = Array.from({ length: 30 }, (_, i) => `セッション語彙${i}`);
    const prompt = buildSttPrompt({ session });
    for (const term of ['リリース', 'マージ', 'コミット', 'パネル']) {
      expect(prompt).toContain(term);
    }
    expect(prompt.length).toBeLessThanOrEqual(190);
  });

  test('the shared words compete with the session for that half, session first', () => {
    const session = ['あ'.repeat(92)];
    const prompt = buildSttPrompt({ session, shared: ['確定申告'] }, ['ペイン']);
    // 92 leaves no room for 確定申告 (4 + 1) inside the 95 the two share, but
    // ペイン still gets in on the glossary's own budget.
    expect(prompt).toBe(`${session[0]}、ペイン`);
  });

  test('a session vocabulary does not cost the glossary', () => {
    // The point of putting the session first is that it beats *our* guesses,
    // not that it replaces the words misheard every day.
    const prompt = buildSttPrompt({
      session: ['温泉式', '文字起こし', 'ハルシネーション'],
      shared: ['確定申告', '固定資産税'],
    });
    // The last glossary term too, so a glossary cut short fails here.
    for (const term of ['温泉式', '確定申告', 'リリース', 'マージ', 'パネル', 'ターミナル']) {
      expect(prompt).toContain(term);
    }
  });

  test('the glossary survives on its own when nothing else is set', () => {
    // The regression this issue is about: with workspace labels leading the
    // prompt, `タブ` was the only glossary term that fit and `リリース`,
    // `コミット`, `リベース` and `ペイン` were all pushed out.
    const prompt = buildSttPrompt();
    for (const term of ['リリース', 'コミット', 'パネル', 'デプロイ', 'ターミナル']) {
      expect(prompt).toContain(term);
    }
  });

  test('the whole prompt stays inside the cap', () => {
    const session = Array.from({ length: 40 }, (_, i) => `セッション語彙${i}`);
    expect(buildSttPrompt({ session }).length).toBeLessThanOrEqual(190);
  });
});

describe('sessionPromptTerms', () => {
  test('splits a written phrase into whole terms', () => {
    expect(sessionPromptTerms('音声認識、Groq, ダッシュボード')).toEqual([
      '音声認識',
      'Groq',
      'ダッシュボード',
    ]);
  });

  test('is empty for a session that has none', () => {
    expect(sessionPromptTerms(undefined)).toEqual([]);
    expect(sessionPromptTerms('  、 ,')).toEqual([]);
  });
});
