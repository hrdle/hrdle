import { describe, expect, test } from 'bun:test';
import { applySttCorrections, isHallucination } from '../../src/services/stt-corrections';

/**
 * The cases here are transcripts that actually came back, recovered from the
 * glasses screen recording for 2026-08-02..09. Nothing is invented: a rule
 * nobody has seen fire is a rule nobody can tell is wrong.
 */
describe('stt corrections: spelling the prompt cannot reach', () => {
  test('writes the product names the way they are written, not heard', () => {
    expect(applySttCorrections('ハーダーのセッションを立ち上げてください')).toBe(
      'herdrのセッションを立ち上げてください',
    );
    expect(applySttCorrections('GitHubイッシューに登録したと思うんですけど')).toBe(
      'GitHubissueに登録したと思うんですけど',
    );
    expect(applySttCorrections('コーデックスエージェントを起動して')).toBe(
      'Codexエージェントを起動して',
    );
  });

  test('prefers the longest spelling so a prefix cannot win', () => {
    // `クロード` alone would leave `Claudeコード`.
    expect(applySttCorrections('クロードコードで直してください')).toBe(
      'Claude Codeで直してください',
    );
    expect(applySttCorrections('クロードMDに書いておいてください')).toBe(
      'ClaudeMDに書いておいてください',
    );
  });

  test('leaves speech that needs no repair exactly as it is', () => {
    const said = 'ワークスペース名を変更してほしいというだけです';
    expect(applySttCorrections(said)).toBe(said);
  });
});

describe('stt corrections: what Whisper writes into silence', () => {
  test('empties the sign-off nobody said', () => {
    // Thirteen of these in eight days.
    expect(applySttCorrections('ご視聴ありがとうございました')).toBe('');
    expect(applySttCorrections('ご視聴ありがとうございました。')).toBe('');
    expect(applySttCorrections('  おやすみなさい  ')).toBe('');
  });

  test('keeps the same words when they are part of a sentence', () => {
    // The defect is a whole transcript that is only the sign-off. Cutting
    // these words out of real speech would be the worse failure.
    const said = 'ありがとうございました、これで大丈夫です';
    expect(applySttCorrections(said)).toBe(said);
    expect(isHallucination(said)).toBe(false);
  });

  test('an empty body stays empty rather than becoming a repair', () => {
    expect(applySttCorrections('')).toBe('');
    expect(applySttCorrections('   ')).toBe('');
  });
});
