import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../../shared/identity';

/**
 * Adding is the default because a vocabulary is a list that grows. A caller
 * that meant to add one word and replaced the list instead loses the rest, and
 * nothing in a transcription shows it happened - the words simply stop being
 * recognised.
 */
let scratch: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), `${IDENTITY.tmpPrefix}-stt-vocab-`));
  previousDataDir = process.env[IDENTITY.dataDirEnv];
  process.env[IDENTITY.dataDirEnv] = scratch;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env[IDENTITY.dataDirEnv];
  else process.env[IDENTITY.dataDirEnv] = previousDataDir;
  await rm(scratch, { recursive: true, force: true });
});

describe('addSessionSttTerms', () => {
  test('keeps what is there and appends what is new', async () => {
    const { addSessionSttTerms, setSessionSttPrompt } = await import('../session-metadata');
    await setSessionSttPrompt('w1', '味噌、だし');

    const result = await addSessionSttTerms('w1', ['ぬか床'], 190);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toEqual(['ぬか床']);
      expect(result.stored).toBe('味噌、だし、ぬか床');
    }
  });

  test('a term already there is named rather than added twice', async () => {
    const { addSessionSttTerms, setSessionSttPrompt } = await import('../session-metadata');
    await setSessionSttPrompt('w1', '味噌');

    const result = await addSessionSttTerms('w1', ['味噌', 'だし'], 190);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.duplicate).toEqual(['味噌']);
      expect(result.stored).toBe('味噌、だし');
    }
  });

  test('an overflow writes nothing and says what it would have been', async () => {
    const { addSessionSttTerms, getAllSessionMetadata, setSessionSttPrompt } = await import(
      '../session-metadata'
    );
    const full = 'あ'.repeat(188);
    await setSessionSttPrompt('w1', full);

    const result = await addSessionSttTerms('w1', ['ぬか床'], 190);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.wouldBe).toBe(192);
    // Nothing is truncated to fit: a list cut down invisibly is the failure
    // this area keeps producing.
    expect((await getAllSessionMetadata()).w1.sttPrompt).toBe(full);
  });

  test('adds to a workspace that had no vocabulary at all', async () => {
    const { addSessionSttTerms } = await import('../session-metadata');

    const result = await addSessionSttTerms('w9', ['ぬか床', '味噌'], 190);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stored).toBe('ぬか床、味噌');
  });
});
