import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../shared/identity';
import {
  resetGlassesSettingsCache,
  updateGlassesSettings,
} from '../../src/services/glasses-settings';
import { resetSttPromptCache, sttPrompt } from '../../src/services/stt-prompt';

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
  resetSttPromptCache();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = prevDataDir;
  if (prevPrompt === undefined) delete process.env[PROMPT_ENV];
  else process.env[PROMPT_ENV] = prevPrompt;
  resetGlassesSettingsCache();
  resetSttPromptCache();
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Three sources, and the one a person can reach from the glasses wins. The env
 * var stays for an A/B run that should not outlive the process.
 */
describe('STT prompt precedence', () => {
  test('a saved prompt beats the environment', async () => {
    process.env[PROMPT_ENV] = 'from env';
    await updateGlassesSettings({ sttPrompt: 'from settings' });
    resetSttPromptCache();
    expect(await sttPrompt()).toBe('from settings');
  });

  test('the environment applies when nothing is saved', async () => {
    process.env[PROMPT_ENV] = 'from env';
    resetSttPromptCache();
    expect(await sttPrompt()).toBe('from env');
  });

  test('`off` from the settings disables the prompt entirely', async () => {
    process.env[PROMPT_ENV] = 'from env';
    await updateGlassesSettings({ sttPrompt: 'off' });
    resetSttPromptCache();
    expect(await sttPrompt()).toBeUndefined();
  });

  test('clearing the saved prompt hands it back to the environment', async () => {
    await updateGlassesSettings({ sttPrompt: 'from settings' });
    await updateGlassesSettings({ sttPrompt: null });
    process.env[PROMPT_ENV] = 'from env';
    resetSttPromptCache();
    expect(await sttPrompt()).toBe('from env');
  });
});
