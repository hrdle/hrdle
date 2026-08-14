import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { IDENTITY } from '../../../../shared/identity';

/**
 * Falling back to the other transcriber when the chosen one fails.
 *
 * A custom endpoint on another machine (a laptop that sleeps) takes voice
 * input down with it for exactly as long as it is away - unless the escape to
 * Groq actually fires. Whether it fires can only be seen while the primary is
 * down, so that is what these tests stage.
 */
process.env[IDENTITY.dataDirEnv] = mkdtempSync(join(tmpdir(), 'stt-fallback-'));
process.env.GROQ_API_KEY = 'test-key';

const { glasses } = await import('../glasses');
const { resetSttHealth, sttHealth } = await import('../../services/stt-provider');
const { resetGlassesSettingsCache, updateGlassesSettings } = await import(
  '../../services/glasses-settings'
);

const ENDPOINT = 'http://127.0.0.1:9/v1/audio/transcriptions';

beforeEach(async () => {
  // The vocabulary prompt is switched off so these tests exercise only the
  // destination switching, without dragging session vocabulary loading in.
  await updateGlassesSettings({
    sttEndpointUrl: ENDPOINT,
    sttEndpointModel: null,
    sttProvider: null,
    sttFallback: null,
    sttBias: 'off',
  });
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  // The "known to be down" memory is process state; carried over, the next
  // test would skip the primary for the wrong reason.
  resetSttHealth();
  await updateGlassesSettings({
    sttEndpointUrl: null,
    sttEndpointModel: null,
    sttProvider: null,
    sttFallback: null,
    sttBias: null,
  });
  resetGlassesSettingsCache();
});

/** 0.1s of silent PCM (16-bit / 16kHz). The content is never inspected. */
const silence = () => new Uint8Array(3200);

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    return handler(url);
  }) as typeof fetch;
  return seen;
}

const transcribe = () =>
  glasses.request('/stt?format=pcm&lang=ja', { method: 'POST', body: silence() });

test('an unreachable primary falls back to Groq', async () => {
  const seen = stubFetch((url) => {
    if (url.startsWith('http://127.0.0.1:9')) throw new Error('connection refused');
    return Response.json({ text: 'hello' });
  });

  const res = await transcribe();

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: 'hello' });
  expect(seen).toHaveLength(2);
  expect(seen[1]).toContain('api.groq.com');
});

test('a broken primary (5xx) falls back too', async () => {
  const seen = stubFetch((url) =>
    url.startsWith('http://127.0.0.1:9')
      ? new Response('boom', { status: 503 })
      : Response.json({ text: 'back' }),
  );

  const res = await transcribe();

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: 'back' });
  expect(seen[1]).toContain('api.groq.com');
});

test('a 4xx does not fall back - it answers the same wherever it is sent', async () => {
  const seen = stubFetch(() => new Response('bad request', { status: 400 }));

  const res = await transcribe();

  expect(res.status).toBe(502);
  expect(seen).toHaveLength(1);
});

test('a primary that answers keeps Groq untouched', async () => {
  const seen = stubFetch(() => Response.json({ text: 'morning' }));

  const res = await transcribe();

  expect(await res.json()).toEqual({ text: 'morning' });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toStartWith('http://127.0.0.1:9');
});

test('after one failure the primary is skipped, so nobody waits out the timeout twice', async () => {
  const first = stubFetch((url) => {
    if (url.startsWith('http://127.0.0.1:9')) throw new Error('host is asleep');
    return Response.json({ text: 'first' });
  });
  await transcribe();
  expect(first).toHaveLength(2); // primary, then Groq

  const second = stubFetch(() => Response.json({ text: 'second' }));
  const res = await transcribe();

  expect(await res.json()).toEqual({ text: 'second' });
  expect(second).toHaveLength(1);
  expect(second[0]).toContain('api.groq.com'); // straight to the fallback
});

test('the switch to the fallback is visible as state', async () => {
  expect(sttHealth().primaryDown).toBe(false);

  stubFetch((url) => {
    if (url.startsWith('http://127.0.0.1:9')) throw new Error('host is asleep');
    return Response.json({ text: 'ok' });
  });
  await transcribe();

  const health = sttHealth();
  expect(health.primaryDown).toBe(true);
  expect(health.lastFallbackAt).toBeString();
});

test('a primary that comes back clears the state', async () => {
  stubFetch((url) => {
    if (url.startsWith('http://127.0.0.1:9')) throw new Error('host is asleep');
    return Response.json({ text: 'via Groq' });
  });
  await transcribe();
  expect(sttHealth().primaryDown).toBe(true);

  // After the retry window the primary is tried again; here the memory is
  // cleared to stage the recovered state.
  resetSttHealth();
  const seen = stubFetch(() => Response.json({ text: 'back on local' }));
  await transcribe();

  expect(seen).toHaveLength(1);
  expect(seen[0]).toStartWith('http://127.0.0.1:9');
  expect(sttHealth().primaryDown).toBe(false);
});

test('the fallback switch turns the escape off', async () => {
  await updateGlassesSettings({ sttFallback: 'off' });
  const seen = stubFetch(() => {
    throw new Error('connection refused');
  });

  const res = await transcribe();

  expect(res.status).toBe(500);
  expect(seen).toHaveLength(1);
});

test('choosing Groq first makes the custom endpoint the escape', async () => {
  await updateGlassesSettings({ sttProvider: 'groq' });
  const seen = stubFetch((url) => {
    if (url.includes('api.groq.com')) throw new Error('groq outage');
    return Response.json({ text: 'custom caught it' });
  });

  const res = await transcribe();

  expect(await res.json()).toEqual({ text: 'custom caught it' });
  expect(seen).toHaveLength(2);
  expect(seen[0]).toContain('api.groq.com');
  expect(seen[1]).toStartWith('http://127.0.0.1:9');
});

test('/stt-preview answers with the model actually sent', async () => {
  // `resolveSttRequest` guarantees "what the preview reports is what the
  // transcription sends"; a custom endpoint naming its own model must not
  // quietly break that. Preview and the multipart `model` must agree.
  await updateGlassesSettings({ sttEndpointModel: 'whisper-1' });
  const preview = await glasses.request('/stt-preview');
  const shown = (await preview.json()) as {
    model: string;
    modelSource?: string;
    destination?: string;
  };

  let sent = '';
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit) => {
    sent = String((init.body as FormData).get('model'));
    return Response.json({ text: 'ok' });
  }) as typeof fetch;
  await glasses.request('/stt', {
    method: 'POST',
    headers: { 'content-type': 'audio/pcm' },
    body: silence(),
  });

  expect(sent).toBe('whisper-1');
  expect(shown.model).toBe(sent);
  expect(shown.destination).toBe('127.0.0.1'); // where it goes is in the preview too
  // And it says honestly where the name came from - claiming `setting` or
  // `default` for a value the endpoint imposed would print a lie.
  expect(shown.modelSource).toBe('endpoint');
});

test('while the fallback stands in, the preview answers the fallback', async () => {
  // The preview's contract is "what is being sent right now", not "what the
  // settings would prefer". Answering the configured primary during the
  // 60-second skip window would be sixty seconds of lying.
  await updateGlassesSettings({ sttEndpointModel: 'whisper-1' });
  stubFetch((url) => {
    if (url.startsWith('http://127.0.0.1:9')) throw new Error('host is asleep');
    return Response.json({ text: 'Groq answered' });
  });
  await transcribe(); // records the primary as down

  const shown = (await (await glasses.request('/stt-preview')).json()) as {
    model: string;
    destination: string;
    fallback: string | null;
  };
  expect(shown.destination).toBe('Groq'); // the escape is the answer
  expect(shown.model).toBe('whisper-large-v3-turbo'); // Groq speaks the chosen model
  expect(shown.fallback).toBeNull(); // there is nowhere further to escape to
});
