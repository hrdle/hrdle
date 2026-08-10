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
import { IDENTITY, envVar } from '../../../shared/identity';
import { resetGlassesSettingsCache } from '../../src/services/glasses-settings';
import { setSessionSttPrompt } from '../../src/services/session-metadata';
import {
  flushGlassesRecorder,
  readRecordingDay,
  resetGlassesRecorderForTest,
} from '../../src/services/glasses-screen-recorder';
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

/**
 * The recording is the measurement (#255 follow-up).
 *
 * Audio is never stored, so "does this model hear better" can only be
 * answered by reading transcripts back - and a transcript that does not say
 * which model and which prompt produced it leaves the comparison resting on
 * somebody's memory of when the setting was last changed.
 */
describe('POST /stt writes what it asked for into the recording', () => {
  const RECORD_ENV = envVar('GLASSES_RECORD');
  let savedFetch: typeof fetch;
  let savedRecord: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    savedRecord = process.env[RECORD_ENV];
    savedKey = process.env.GROQ_API_KEY;
    process.env[RECORD_ENV] = '1';
    process.env.GROQ_API_KEY = 'gsk_test';
    resetGlassesRecorderForTest();
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedRecord === undefined) delete process.env[RECORD_ENV];
    else process.env[RECORD_ENV] = savedRecord;
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    resetGlassesRecorderForTest();
  });

  async function transcribe(reply: { status: number; text?: string }): Promise<void> {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: reply.text ?? '' }), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await glasses.request('/stt?session=w4Y', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      // 16000 bytes of silence: one second at the default sample rate.
      body: new Uint8Array(32000),
    });
    await flushGlassesRecorder();
  }

  async function sttLines(): Promise<Array<Record<string, unknown>>> {
    const day = new Date();
    const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const lines = (await readRecordingDay(stamp)) ?? [];
    return lines.filter((l) => 'stt' in l) as unknown as Array<Record<string, unknown>>;
  }

  test('the model, the prompt and the words land on one line', async () => {
    await setSessionSttPrompt('w4Y', '確定申告');
    await transcribe({ status: 200, text: '確定申告について' });

    const [line] = await sttLines();
    const stt = line.stt as Record<string, unknown>;
    expect(stt.model).toBe('whisper-large-v3-turbo');
    expect(stt.sessionId).toBe('w4Y');
    expect(stt.text).toBe('確定申告について');
    expect(String(stt.prompt).startsWith('確定申告')).toBe(true);
    expect(stt.promptSource).toBe('composed');
    // One second of 16-bit mono at 16kHz.
    expect(stt.audioSeconds).toBeCloseTo(1, 5);
  });

  test('the raw text is kept only when the corrections changed it', async () => {
    await transcribe({ status: 200, text: 'ハーダーの話' });
    let stt = (await sttLines())[0].stt as Record<string, unknown>;
    expect(stt.text).toBe('herdrの話');
    expect(stt.raw).toBe('ハーダーの話');

    resetGlassesRecorderForTest();
    await transcribe({ status: 200, text: 'リリースの話' });
    stt = (await sttLines()).at(-1)?.stt as Record<string, unknown>;
    expect(stt.text).toBe('リリースの話');
    expect(stt.raw).toBeUndefined();
  });

  test('a provider error is recorded too - it says what was asked for', async () => {
    await transcribe({ status: 502 });
    const stt = (await sttLines())[0].stt as Record<string, unknown>;
    expect(stt.ok).toBe(false);
    expect(stt.text).toBeUndefined();
    expect(stt.model).toBe('whisper-large-v3-turbo');
  });

  test('nothing is written when the recording is off', async () => {
    process.env[RECORD_ENV] = '0';
    await transcribe({ status: 200, text: 'なにか' });
    expect(await sttLines()).toHaveLength(0);
  });
});
