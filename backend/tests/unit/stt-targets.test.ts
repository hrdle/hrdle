// Where a transcription goes, resolved from the glasses settings. The two
// halves of a target (URL and model) always come from the same source -
// mixing the store's Groq model names with a custom endpoint's URL 400s on
// every utterance.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY } from '../../../shared/identity';
import {
  resetGlassesSettingsCache,
  updateGlassesSettings,
} from '../../src/services/glasses-settings';
import { resolveSttEndpoint, sttTargets } from '../../src/services/stt-provider';

const DATA_DIR_ENV = IDENTITY.dataDirEnv;

let tempDir: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'stt-targets-'));
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

describe('where a transcription goes', () => {
  test('nothing configured means Groq, with no fallback to speak of', async () => {
    const { primary, fallback, source, provider } = await sttTargets('whisper-large-v3-turbo');
    expect(primary.label).toBe('Groq');
    expect(primary.billed).toBe(true);
    expect(fallback).toBeNull();
    expect(source).toBe('none');
    expect(provider).toBe('groq');
  });

  test('a configured endpoint becomes the primary, model included, with Groq as the escape', async () => {
    await updateGlassesSettings({
      sttEndpointUrl: 'https://stt-host.example:8447/v1/audio/transcriptions',
      sttEndpointModel: 'whisper-1',
    });

    const { primary, fallback, source, provider } = await sttTargets('whisper-large-v3-turbo');
    expect(source).toBe('setting');
    expect(provider).toBe('custom');
    expect(primary.url).toContain('stt-host');
    expect(primary.model).toBe('whisper-1');
    expect(primary.billed).toBe(false);
    // The escape speaks the *chosen* model, not the endpoint's own.
    expect(fallback?.label).toBe('Groq');
    expect(fallback?.model).toBe('whisper-large-v3-turbo');
  });

  test('an endpoint with no model of its own uses the chosen default', async () => {
    await updateGlassesSettings({
      sttEndpointUrl: 'https://stt-host.example/v1/audio/transcriptions',
    });
    const { primary } = await sttTargets('whisper-large-v3');
    expect(primary.model).toBe('whisper-large-v3');
  });

  test('the fallback switch turns the escape off', async () => {
    await updateGlassesSettings({
      sttEndpointUrl: 'https://stt-host.example/v1/audio/transcriptions',
      sttFallback: 'off',
    });
    const { fallback } = await sttTargets('whisper-large-v3-turbo');
    expect(fallback).toBeNull();
  });

  test('choosing Groq first keeps the custom endpoint as the escape', async () => {
    await updateGlassesSettings({
      sttEndpointUrl: 'https://stt-host.example/v1/audio/transcriptions',
      sttEndpointModel: 'whisper-1',
      sttProvider: 'groq',
    });
    const { primary, fallback, provider } = await sttTargets('whisper-large-v3-turbo');
    expect(provider).toBe('groq');
    expect(primary.label).toBe('Groq');
    expect(primary.billed).toBe(true);
    // The escape runs the other way - and carries its own model with it.
    expect(fallback?.label).toBe('stt-host');
    expect(fallback?.model).toBe('whisper-1');
  });

  test('choosing the custom server with no URL set resolves to Groq entire', async () => {
    // A choice pointing at nothing must not take every utterance down with it.
    await updateGlassesSettings({ sttProvider: 'custom' });
    const { primary, provider } = await sttTargets('whisper-large-v3-turbo');
    expect(provider).toBe('groq');
    expect(primary.label).toBe('Groq');
  });

  test('clearing the endpoint returns to Groq', async () => {
    await updateGlassesSettings({ sttEndpointUrl: 'https://stt-host.example/v1' });
    await updateGlassesSettings({ sttEndpointUrl: null, sttEndpointModel: null, sttFallback: null });

    const endpoint = await resolveSttEndpoint();
    expect(endpoint.source).toBe('none');
  });

  test('a URL that is not http(s) never reaches the store', async () => {
    await updateGlassesSettings({ sttEndpointUrl: 'file:///etc/passwd' });
    const endpoint = await resolveSttEndpoint();
    expect(endpoint.source).toBe('none');
  });
});
