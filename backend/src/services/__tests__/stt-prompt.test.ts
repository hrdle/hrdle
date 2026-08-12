import { describe, expect, test } from 'bun:test';
import { composeSttPrompt, sessionPromptTerms, sharedGlossary } from '../stt-prompt';

/** The line alone, for the cases that are only about what it says. */
function line(session: string[] = [], glossary?: string[]): string {
  return composeSttPrompt(session, glossary ? { glossary } : {}).prompt;
}

/**
 * The prompt is the only thing telling Whisper that `herdr` is a word and that
 * `ペイン` is not `ペイント`. It is also capped, so what gets dropped when it is
 * full is the part worth pinning - which is why what goes in it is now said
 * deliberately (a session's own words) rather than scraped from workspace
 * labels.
 */
describe('composeSttPrompt', () => {
  test("the speaking session's own words come first", () => {
    expect(line(['音声認識', 'Groq'], ['ペイン'])).toBe('音声認識、Groq、ペイン');
  });

  test('a term the session and the glossary both name is said once', () => {
    expect(line(['Groq'], ['groq'])).toBe('Groq');
  });

  test('blank terms are skipped rather than left as empty slots', () => {
    expect(line(['', '   ', 'life'], [])).toBe('life');
  });

  test('nothing to say means no prompt at all', () => {
    // The caller sends nothing rather than an empty `prompt` field.
    expect(line([], [])).toBe('');
  });

  test('the cap drops whole terms, never half of one', () => {
    const session = 'あ'.repeat(93);
    // 93 + 1 + 3 = 97 for ペイン; the 100-character term would take the line
    // past 190 and is left out whole.
    expect(line([session], ['ペイン', 'い'.repeat(100)])).toBe(`${session}、ペイン`);
  });

  test('a term too long to fit does not block the shorter ones behind it', () => {
    expect(line(['い'.repeat(200), 'life'], [])).toBe('life');
  });

  test('the session cannot take more than half the budget', () => {
    // The failure mode the cap exists for: a session naming everything it
    // might ever say must not cost the words misheard in every session.
    const session = Array.from({ length: 30 }, (_, i) => `セッション語彙${i}`);
    const prompt = line(session);
    for (const term of ['リリース', 'マージ', 'コミット', 'パネル']) {
      expect(prompt).toContain(term);
    }
    expect(prompt.length).toBeLessThanOrEqual(190);
  });

  test('a session vocabulary does not cost the glossary', () => {
    // The point of putting the session first is that it beats *our* guesses,
    // not that it replaces the words misheard every day.
    const prompt = line(['温泉式', '文字起こし', 'ハルシネーション']);
    // The last glossary term too, so a glossary cut short fails here.
    for (const term of ['温泉式', 'リリース', 'マージ', 'パネル', 'ターミナル']) {
      expect(prompt).toContain(term);
    }
  });

  test('the glossary survives on its own when nothing else is set', () => {
    // The regression this issue is about: with workspace labels leading the
    // prompt, `タブ` was the only glossary term that fit and `リリース`,
    // `コミット`, `リベース` and `ペイン` were all pushed out.
    const prompt = line();
    for (const term of ['リリース', 'コミット', 'パネル', 'デプロイ', 'ターミナル']) {
      expect(prompt).toContain(term);
    }
  });

  test('the whole prompt stays inside the cap', () => {
    const session = Array.from({ length: 40 }, (_, i) => `セッション語彙${i}`);
    expect(line(session).length).toBeLessThanOrEqual(190);
  });
});

/**
 * The line is one string of comma-separated words by the time it leaves here,
 * so "why is my session's word not in it" can only be answered by what the
 * composition says about the groups.
 */
describe('composeSttPrompt reports how it got there', () => {
  test('each group says which of its terms made it in', () => {
    const composition = composeSttPrompt(['音声認識'], { glossary: ['パネル'] });
    expect(composition.groups.map((g) => g.name)).toEqual(['session', 'glossary']);
    expect(composition.groups[0].taken).toEqual(['音声認識']);
    expect(composition.groups[1].taken).toEqual(['パネル']);
    expect(composition.usedChars).toBe('音声認識、パネル'.length);
    expect(composition.maxChars).toBe(190);
  });

  test('a term cut by the budget is named, with the budget as the reason', () => {
    const long = 'あ'.repeat(94);
    const composition = composeSttPrompt([long, '確定申告'], { glossary: [] });
    expect(composition.groups[0].taken).toEqual([long]);
    // 94 + 1 + 4 is past the 95 the session may take.
    expect(composition.groups[0].skipped).toEqual([{ term: '確定申告', reason: 'budget' }]);
  });

  test('a term the session already said is named as a duplicate, not as dropped', () => {
    const composition = composeSttPrompt(['パネル'], { glossary: ['パネル', 'リリース'] });
    expect(composition.groups[1].skipped).toEqual([{ term: 'パネル', reason: 'duplicate' }]);
    expect(composition.groups[1].taken).toContain('リリース');
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

/**
 * A workspace whose subject is not this product says none of the glossary's
 * words, and the half of the line reserved for them cannot be spent. Declining
 * the glossary is what gives that budget back.
 */
describe('a workspace can decline the shared glossary', () => {
  const cooking = [
    '全粒粉', 'ベーグル', 'ラタトゥイユ', '強力粉', '干し椎茸', 'ささみ', 'オクラ',
    'ズッキーニ', 'ひじき', 'さば水煮缶', '作り置き', '鶏むね', '木綿豆腐',
    '落とし焼き', '塩昆布', '玉ねぎ', '買い物リスト', '炊き込みご飯',
  ];

  // 18 terms is 90 of the 95 the session may take while the glossary is on, so
  // a sixth-character term does not fit. That is the reported symptom: half
  // the line is held for words this workspace cannot say, and it is full.
  const oneMore = [...cooking, '切り干し大根'];

  test('with it on, the next term is cut and the glossary takes the rest', () => {
    const composition = composeSttPrompt(oneMore, { glossary: ['リリース', 'コミット'] });
    expect(composition.glossaryEnabled).toBe(true);
    expect(composition.groups[0].skipped).toEqual([{ term: '切り干し大根', reason: 'budget' }]);
    expect(composition.groups[1].taken).toEqual(['リリース', 'コミット']);
  });

  test('with it off, the same term fits and no glossary term is offered', () => {
    const composition = composeSttPrompt(oneMore, {
      glossaryEnabled: false,
      glossary: ['リリース', 'コミット'],
    });
    expect(composition.glossaryEnabled).toBe(false);
    expect(composition.groups[0].taken).toEqual(oneMore);
    expect(composition.groups[1].taken).toEqual([]);
    expect(composition.groups[1].skipped).toEqual([]);
  });

  test('declining does not lift the cap on the line itself', () => {
    const composition = composeSttPrompt(['あ'.repeat(200), '味噌'], {
      glossaryEnabled: false,
    });
    expect(composition.groups[0].skipped[0]).toEqual({
      term: 'あ'.repeat(200),
      reason: 'budget',
    });
    expect(composition.usedChars).toBeLessThanOrEqual(190);
  });
});

/**
 * A new workspace takes a copy of the glossary instead of sharing it, so that
 * its vocabulary is one list it owns from the start - terms it will never say
 * can be deleted, which a shared layer cannot offer.
 */
describe('seedWorkspaceVocabulary', () => {
  test('the seeded copy is the glossary, and it fits the line', () => {
    const seeded = sharedGlossary().join('、');
    const composition = composeSttPrompt(sessionPromptTerms(seeded), {
      glossaryEnabled: false,
    });
    expect(composition.groups[0].skipped).toEqual([]);
    expect(composition.prompt).toBe(seeded);
    expect(composition.usedChars).toBeLessThan(composition.maxChars);
  });

  test('a seeded workspace has room left for words of its own', () => {
    const seeded = sharedGlossary().join('、');
    const composition = composeSttPrompt(
      [...sessionPromptTerms(seeded), '確定申告', 'ぬか床'],
      { glossaryEnabled: false },
    );
    expect(composition.groups[0].taken).toContain('確定申告');
    expect(composition.groups[0].taken).toContain('ぬか床');
  });
});
