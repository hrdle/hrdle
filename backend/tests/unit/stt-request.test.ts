import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../shared/identity';
import {
  resetGlassesSettingsCache,
  updateGlassesSettings,
} from '../../src/services/glasses-settings';
import { setSessionSttPrompt } from '../../src/services/session-metadata';
import { resolveSttRequest } from '../../src/services/stt-request';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;
const PROMPT_ENV = `${IDENTITY.binaryName.toUpperCase()}_STT_PROMPT`;

let tempDir: string;
let prevDataDir: string | undefined;
let prevPrompt: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'stt-request-'));
  prevDataDir = process.env[DATA_DIR_ENV];
  prevPrompt = process.env[PROMPT_ENV];
  process.env[DATA_DIR_ENV] = tempDir;
  delete process.env[PROMPT_ENV];
  resetGlassesSettingsCache();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = prevDataDir;
  if (prevPrompt === undefined) delete process.env[PROMPT_ENV];
  else process.env[PROMPT_ENV] = prevPrompt;
  resetGlassesSettingsCache();
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * One function decides everything a transcription carries except the key, so
 * this is where every precedence rule is asserted (#255). It used to be four
 * functions in four files, and reading them all was the only way to know what
 * a session was actually sending.
 */
describe('resolveSttRequest', () => {
  test('with nothing set, it is turbo, Japanese and the glossary', async () => {
    const req = await resolveSttRequest();
    expect(req.model).toBe('whisper-large-v3-turbo');
    expect(req.modelSource).toBe('default');
    expect(req.language).toBe('ja');
    expect(req.languageSource).toBe('default');
    expect(req.promptSource).toBe('composed');
    expect(req.prompt).toContain('リリース');
    // The spoken word for a pane. `ペイン` is the code's word and was never
    // said once in 1030 recorded utterances; `パネル` was said eleven times.
    expect(req.prompt).toContain('パネル');
    expect(req.prompt).not.toContain('ペイン');
  });

  test("the named session's own words lead the prompt", async () => {
    await setSessionSttPrompt('w4Y', '確定申告、固定資産税');
    const req = await resolveSttRequest({ sessionId: 'w4Y' });
    expect(req.sessionId).toBe('w4Y');
    expect(req.prompt?.startsWith('確定申告、固定資産税')).toBe(true);
    // The glossary is still behind them - the half-budget cap (#210).
    expect(req.prompt).toContain('リリース');
    expect(req.prompt).toContain('ターミナル');
    // And the composition says which group each term came from, which is the
    // question the preview endpoint exists to answer.
    expect(req.promptComposition?.groups[0]).toMatchObject({
      name: 'session',
      taken: ['確定申告', '固定資産税'],
    });
  });

  test('another session is unaffected by it', async () => {
    await setSessionSttPrompt('w4Y', '確定申告');
    const req = await resolveSttRequest({ sessionId: 'w5Q' });
    expect(req.prompt).not.toContain('確定申告');
  });

  test('a session id that names nothing is not an error, just no words', async () => {
    const req = await resolveSttRequest({ sessionId: 'nobody' });
    expect(req.promptComposition?.groups[0].taken).toEqual([]);
    expect(req.prompt).toContain('リリース');
  });

  test('`?lang=` outranks the saved language, and `auto` sends none', async () => {
    await updateGlassesSettings({ sttLang: 'en' });
    expect(await resolveSttRequest()).toMatchObject({ language: 'en', languageSource: 'setting' });
    expect(await resolveSttRequest({ lang: 'ja' })).toMatchObject({
      language: 'ja',
      languageSource: 'request',
    });
    expect(await resolveSttRequest({ lang: 'auto' })).toMatchObject({
      language: null,
      languageSource: 'request',
    });

    await updateGlassesSettings({ sttLang: 'auto' });
    expect(await resolveSttRequest()).toMatchObject({ language: null, languageSource: 'setting' });
  });

  test('the saved model is what goes out', async () => {
    await updateGlassesSettings({ sttModel: 'whisper-large-v3' });
    expect(await resolveSttRequest()).toMatchObject({
      model: 'whisper-large-v3',
      modelSource: 'setting',
    });
  });

  test('the environment still replaces the whole line, for an A/B run', async () => {
    process.env[PROMPT_ENV] = 'from env';
    await setSessionSttPrompt('w4Y', '確定申告');
    const req = await resolveSttRequest({ sessionId: 'w4Y' });
    expect(req.prompt).toBe('from env');
    expect(req.promptSource).toBe('env');
    // Nothing was composed, so there is no composition to explain.
    expect(req.promptComposition).toBeNull();
  });

  test('the switch turns the bias off entirely, whatever else is set', async () => {
    process.env[PROMPT_ENV] = 'from env';
    await updateGlassesSettings({ sttBias: 'off' });
    const req = await resolveSttRequest({ sessionId: 'w4Y' });
    expect(req.prompt).toBeNull();
    expect(req.promptSource).toBe('off');
    // The model and language are still resolved - only the bias is off.
    expect(req.model).toBe('whisper-large-v3-turbo');
    expect(req.language).toBe('ja');
  });

  test('`off` from the environment disables it too', async () => {
    process.env[PROMPT_ENV] = 'off';
    expect(await resolveSttRequest()).toMatchObject({ prompt: null, promptSource: 'off' });
  });

  test('switching the bias back on restores the composed line', async () => {
    await updateGlassesSettings({ sttBias: 'off' });
    await updateGlassesSettings({ sttBias: 'on' });
    const req = await resolveSttRequest();
    expect(req.promptSource).toBe('composed');
    expect(req.prompt).toContain('リリース');
  });

  test('the key is never part of the answer', async () => {
    // This object is served by /stt-preview, and the key is write-only.
    await updateGlassesSettings({ groqApiKey: 'gsk_secret' });
    expect(JSON.stringify(await resolveSttRequest())).not.toContain('gsk_secret');
  });
});
