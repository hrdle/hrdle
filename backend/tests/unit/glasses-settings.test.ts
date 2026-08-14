import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../shared/identity';
import {
  DEFAULT_STT_LANG,
  DEFAULT_STT_MODEL,
  glassesSettingsView,
  loadGlassesSettings,
  resetGlassesSettingsCache,
  resolveGroqApiKey,
  resolveSttBias,
  resolveSttLang,
  resolveSttModel,
  updateGlassesSettings,
} from '../../src/services/glasses-settings';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let tempDir: string;
let prevDataDir: string | undefined;
let prevKey: string | undefined;
let prevPrompt: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'glasses-settings-'));
  prevDataDir = process.env[DATA_DIR_ENV];
  prevKey = process.env.GROQ_API_KEY;
  prevPrompt = process.env[`${IDENTITY.binaryName.toUpperCase()}_STT_PROMPT`];
  process.env[DATA_DIR_ENV] = tempDir;
  delete process.env.GROQ_API_KEY;
  delete process.env[`${IDENTITY.binaryName.toUpperCase()}_STT_PROMPT`];
  resetGlassesSettingsCache();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = prevDataDir;
  if (prevKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = prevKey;
  const promptEnv = `${IDENTITY.binaryName.toUpperCase()}_STT_PROMPT`;
  if (prevPrompt === undefined) delete process.env[promptEnv];
  else process.env[promptEnv] = prevPrompt;
  resetGlassesSettingsCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('glasses settings store', () => {
  test('starts empty and falls back to the environment', async () => {
    expect(await loadGlassesSettings()).toEqual({});
    expect((await resolveGroqApiKey()).source).toBe('none');
    expect(await resolveSttLang()).toEqual({ lang: DEFAULT_STT_LANG, source: 'default' });

    process.env.GROQ_API_KEY = 'from-env';
    expect(await resolveGroqApiKey()).toEqual({ key: 'from-env', source: 'env' });
  });

  test('a saved key wins over the environment', async () => {
    process.env.GROQ_API_KEY = 'from-env';
    await updateGlassesSettings({ groqApiKey: 'from-settings' });
    expect(await resolveGroqApiKey()).toEqual({ key: 'from-settings', source: 'setting' });
  });

  test('null clears a field and returns to the fallback', async () => {
    process.env.GROQ_API_KEY = 'from-env';
    await updateGlassesSettings({ groqApiKey: 'from-settings', sttLang: 'en' });
    expect((await resolveSttLang()).lang).toBe('en');

    await updateGlassesSettings({ groqApiKey: null, sttLang: null });
    expect(await resolveGroqApiKey()).toEqual({ key: 'from-env', source: 'env' });
    expect(await resolveSttLang()).toEqual({ lang: DEFAULT_STT_LANG, source: 'default' });
  });

  test('an omitted field is left alone', async () => {
    await updateGlassesSettings({ groqApiKey: 'keep-me', sttLang: 'en' });
    await updateGlassesSettings({ sttLang: 'ja' });
    expect((await resolveGroqApiKey()).key).toBe('keep-me');
    expect((await resolveSttLang()).lang).toBe('ja');
  });

  test('the transcription model defaults to turbo and can be switched', async () => {
    expect(await resolveSttModel()).toEqual({ model: DEFAULT_STT_MODEL, source: 'default' });

    await updateGlassesSettings({ sttModel: 'whisper-large-v3' });
    expect(await resolveSttModel()).toEqual({ model: 'whisper-large-v3', source: 'setting' });

    await updateGlassesSettings({ sttModel: null });
    expect(await resolveSttModel()).toEqual({ model: DEFAULT_STT_MODEL, source: 'default' });
  });

  test('a model Groq no longer offers reads back as unset', async () => {
    // Otherwise every utterance is a 400 and the only clue is a settings file
    // nobody thinks to open when speech stops working.
    await writeFile(
      join(tempDir, 'glasses-settings.json'),
      JSON.stringify({ sttModel: 'whisper-tiny-retired' }),
    );
    resetGlassesSettingsCache();
    expect((await loadGlassesSettings()).sttModel).toBeUndefined();
    expect(await resolveSttModel()).toEqual({ model: DEFAULT_STT_MODEL, source: 'default' });
  });

  test('the file holding the key is owner-only', async () => {
    await updateGlassesSettings({ groqApiKey: 'secret' });
    const info = await stat(join(tempDir, 'glasses-settings.json'));
    expect(info.mode & 0o777).toBe(0o600);
    // And it really is on disk rather than only in the cache.
    resetGlassesSettingsCache();
    expect(JSON.parse(await readFile(join(tempDir, 'glasses-settings.json'), 'utf-8'))).toEqual({
      groqApiKey: 'secret',
    });
  });

  test('the view never carries the key, only whether one is set', async () => {
    await updateGlassesSettings({ groqApiKey: 'secret' });
    const view = await glassesSettingsView();
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeySource).toBe('setting');
  });

  test('the view reports where each value comes from', async () => {
    let view = await glassesSettingsView();
    expect(view.sttLangSource).toBe('default');
    expect(view.sttBias).toBe(true);
    expect(view.sttBiasSource).toBe('default');

    await updateGlassesSettings({ sttLang: 'auto' });
    view = await glassesSettingsView();
    expect(view.sttLang).toBe('auto');
    expect(view.sttLangSource).toBe('setting');
  });

  test('the view claims nothing about what would be sent', async () => {
    // It has no session, so it never could. The field that read as though it
    // did cost an afternoon (#255); /stt-preview is the endpoint that answers.
    const view = await glassesSettingsView();
    expect(view).not.toHaveProperty('effectivePrompt');
    expect(view).not.toHaveProperty('sttPrompt');
  });
});

/**
 * The bias switch, and the one thing carried over from the shared-words field
 * it replaced (#255).
 */
describe('the auto screen-off timeout', () => {
  test('defaults to never - the screen stayed on before this feature existed', async () => {
    const view = await glassesSettingsView();
    expect(view.screenOffSeconds).toBe(0);
    expect(view.screenOffSecondsSource).toBe('default');
  });

  test('stores seconds, including 0 for never, and clears back to the default', async () => {
    await updateGlassesSettings({ screenOffSeconds: 90 });
    expect((await glassesSettingsView()).screenOffSeconds).toBe(90);
    expect((await glassesSettingsView()).screenOffSecondsSource).toBe('setting');

    // 0 is a value ("never"), not an absence - it must survive the store.
    await updateGlassesSettings({ screenOffSeconds: 0 });
    const never = await glassesSettingsView();
    expect(never.screenOffSeconds).toBe(0);
    expect(never.screenOffSecondsSource).toBe('setting');

    await updateGlassesSettings({ screenOffSeconds: null });
    expect((await glassesSettingsView()).screenOffSecondsSource).toBe('default');
  });

  test('a value outside 0..3600 in the file reads back as unset', async () => {
    await writeFile(
      join(tempDir, 'glasses-settings.json'),
      JSON.stringify({ screenOffSeconds: 7200 }),
    );
    resetGlassesSettingsCache();
    expect((await loadGlassesSettings()).screenOffSeconds).toBeUndefined();
    expect((await glassesSettingsView()).screenOffSecondsSource).toBe('default');
  });
});

describe('the vocabulary bias switch', () => {
  test('it is on until somebody says otherwise', async () => {
    expect(await resolveSttBias()).toEqual({ enabled: true, source: 'default' });
  });

  test('off is saved, and clearing it returns to on', async () => {
    await updateGlassesSettings({ sttBias: 'off' });
    expect(await resolveSttBias()).toEqual({ enabled: false, source: 'setting' });

    await updateGlassesSettings({ sttBias: null });
    expect(await resolveSttBias()).toEqual({ enabled: true, source: 'default' });
  });

  test('the environment can switch it off but the screen cannot switch that back on', async () => {
    process.env[`${IDENTITY.binaryName.toUpperCase()}_STT_PROMPT`] = 'off';
    await updateGlassesSettings({ sttBias: 'on' });
    const view = await glassesSettingsView();
    expect(view.sttBias).toBe(false);
    expect(view.sttBiasSource).toBe('env');
  });

  test('an `off` left in the old shared-words field stays off after the update', async () => {
    // Somebody switched the bias off deliberately by typing `off` into the
    // field that is now gone. An update must not quietly switch it back on.
    await writeFile(
      join(tempDir, 'glasses-settings.json'),
      JSON.stringify({ sttPrompt: 'off', sttLang: 'en' }),
    );
    resetGlassesSettingsCache();
    expect(await resolveSttBias()).toEqual({ enabled: false, source: 'setting' });
    expect((await loadGlassesSettings()).sttLang).toBe('en');
  });

  test('words left in that field are dropped, and the next write forgets them', async () => {
    // They were a group in the prompt and there is no group for them now.
    await writeFile(
      join(tempDir, 'glasses-settings.json'),
      JSON.stringify({ sttPrompt: '確定申告、固定資産税' }),
    );
    resetGlassesSettingsCache();
    expect(await resolveSttBias()).toEqual({ enabled: true, source: 'default' });

    await updateGlassesSettings({ sttLang: 'ja' });
    const onDisk = JSON.parse(await readFile(join(tempDir, 'glasses-settings.json'), 'utf-8'));
    expect(onDisk).toEqual({ sttLang: 'ja' });
  });
});
