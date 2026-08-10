// The endpoint that answers "what is this session sending" (#255).
//
// The value of a preview is entirely in it being the *same* answer the
// transcription gets, so this exercises the route rather than the resolver
// under it: a handler that reached past `resolveSttRequest` for one of the four
// values would be exactly the bug this endpoint was added to make impossible,
// and a resolver test would not see it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../shared/identity';
import { resetGlassesSettingsCache } from '../../src/services/glasses-settings';
import { setSessionSttPrompt } from '../../src/services/session-metadata';
import { glasses } from '../../src/routes/glasses';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let tempDir: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'glasses-preview-'));
  prevDataDir = process.env[DATA_DIR_ENV];
  process.env[DATA_DIR_ENV] = tempDir;
  resetGlassesSettingsCache();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = prevDataDir;
  resetGlassesSettingsCache();
  await rm(tempDir, { recursive: true, force: true });
});

describe('GET /stt-preview', () => {
  test('answers with the whole request, for the session named', async () => {
    await setSessionSttPrompt('w4Y', '確定申告');
    const res = await glasses.request('/stt-preview?session=w4Y&lang=en');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      model: 'whisper-large-v3-turbo',
      modelSource: 'default',
      language: 'en',
      languageSource: 'request',
      promptSource: 'composed',
      sessionId: 'w4Y',
    });
    expect(body.prompt.startsWith('確定申告')).toBe(true);
    expect(body.promptComposition.groups[0]).toMatchObject({
      name: 'session',
      taken: ['確定申告'],
    });
  });

  test('never carries the key, which is the reason it reports the rest', async () => {
    await glasses.request('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groqApiKey: 'gsk_secret' }),
    });
    const body = await (await glasses.request('/stt-preview')).text();
    expect(body).not.toContain('gsk_secret');
  });
});

describe('PUT /settings', () => {
  test('the bias switch is stored and reported back', async () => {
    const res = await glasses.request('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sttBias: 'off' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sttBias: false, sttBiasSource: 'setting' });

    // And the switch reaches the thing it is a switch for.
    const preview = await (await glasses.request('/stt-preview')).json();
    expect(preview).toMatchObject({ prompt: null, promptSource: 'off' });
  });

  test('anything but on or off is refused rather than stored', async () => {
    const res = await glasses.request('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sttBias: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  test('the settings view says nothing about what would be sent', async () => {
    const view = await (await glasses.request('/settings')).json();
    expect(view).not.toHaveProperty('effectivePrompt');
    expect(view).not.toHaveProperty('sttPrompt');
  });
});
