import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../shared/identity';
import {
  resetGlassesSettingsCache,
  updateGlassesSettings,
} from '../../src/services/glasses-settings';
import { sttPrompt } from '../../src/services/stt-prompt';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;
const PROMPT_ENV = `${IDENTITY.binaryName.toUpperCase()}_STT_PROMPT`;

let tempDir: string;
let prevDataDir: string | undefined;
let prevPrompt: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'stt-precedence-'));
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
 * The saved setting contributes; the environment replaces; `off` from either
 * side switches the bias off entirely.
 *
 * The saved one used to replace too, and outrank the environment doing it. One
 * left over from a comparison then meant five days of five-word prompts and no
 * glossary, silently (#210) - so the field a person can reach from the device
 * is the one that cannot disable everything else by accident.
 */
describe('STT prompt precedence', () => {
  test('the saved words join the composed prompt rather than replacing it', async () => {
    await updateGlassesSettings({ sttPrompt: '確定申告、固定資産税' });
    const prompt = await sttPrompt();
    expect(prompt).toContain('確定申告');
    // The glossary is still there behind them - this is the regression.
    expect(prompt).toContain('リリース');
    expect(prompt).toContain('リベース');
  });

  test('the environment still replaces the whole line, for an A/B run', async () => {
    process.env[PROMPT_ENV] = 'from env';
    expect(await sttPrompt()).toBe('from env');
  });

  test('the environment outranks the saved words, since only one of them replaces', async () => {
    process.env[PROMPT_ENV] = 'from env';
    await updateGlassesSettings({ sttPrompt: '確定申告' });
    expect(await sttPrompt()).toBe('from env');
  });

  test('`off` from the settings disables the prompt entirely', async () => {
    process.env[PROMPT_ENV] = 'from env';
    await updateGlassesSettings({ sttPrompt: 'off' });
    expect(await sttPrompt()).toBeUndefined();
  });

  test('`off` from the environment disables it too', async () => {
    process.env[PROMPT_ENV] = 'off';
    expect(await sttPrompt()).toBeUndefined();
  });

  test('with nothing set at all, the glossary is what goes out', async () => {
    const prompt = await sttPrompt();
    expect(prompt).toContain('リリース');
    expect(prompt).toContain('ペイン');
  });
});
