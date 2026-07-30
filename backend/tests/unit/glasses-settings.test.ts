import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../shared/identity';
import {
  DEFAULT_STT_LANG,
  glassesSettingsView,
  loadGlassesSettings,
  resetGlassesSettingsCache,
  resolveGroqApiKey,
  resolveSttLang,
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
    const view = await glassesSettingsView('composed prompt');
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeySource).toBe('setting');
  });

  test('the view reports where each value comes from', async () => {
    const composed = 'release, merge, pane';
    let view = await glassesSettingsView(composed);
    expect(view.sttPromptSource).toBe('composed');
    expect(view.effectivePrompt).toBe(composed);
    expect(view.sttLangSource).toBe('default');

    process.env[`${IDENTITY.binaryName.toUpperCase()}_STT_PROMPT`] = 'from env';
    resetGlassesSettingsCache();
    view = await glassesSettingsView(composed);
    expect(view.sttPromptSource).toBe('env');
    expect(view.effectivePrompt).toBe('from env');

    await updateGlassesSettings({ sttPrompt: 'from settings', sttLang: 'auto' });
    view = await glassesSettingsView(composed);
    expect(view.sttPromptSource).toBe('setting');
    expect(view.effectivePrompt).toBe('from settings');
    expect(view.sttLang).toBe('auto');
    expect(view.sttLangSource).toBe('setting');
  });

  test('`off` shows as no prompt rather than the literal word', async () => {
    await updateGlassesSettings({ sttPrompt: 'off' });
    expect((await glassesSettingsView('composed')).effectivePrompt).toBe('');
  });
});
