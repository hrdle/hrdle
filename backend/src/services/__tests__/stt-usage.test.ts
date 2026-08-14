import { describe, expect, it } from 'bun:test';
import {
  buildSummary,
  estimateCostUsd,
  parseStore,
  pcmSeconds,
  readRateLimitHeaders,
  wavSeconds,
  type StoredSttDay,
} from '../stt-usage';

function wav(sampleRate: number, samples: number): Uint8Array {
  const pcm = new Uint8Array(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

const day = (over: Partial<StoredSttDay> = {}): StoredSttDay => ({
  requests: 0,
  failures: 0,
  audioSeconds: 0,
  // Everything sent went to the billed target - the assumption that held while
  // there was only one destination.
  billedSeconds: over.audioSeconds ?? 0,
  ...over,
});

describe('pcmSeconds', () => {
  it('reads 16-bit mono PCM at the given sample rate', () => {
    expect(pcmSeconds(16000 * 2, 16000)).toBe(1);
    expect(pcmSeconds(8000, 16000)).toBe(0.25);
  });

  it('returns zero rather than infinity for an impossible sample rate', () => {
    expect(pcmSeconds(32000, 0)).toBe(0);
  });
});

describe('wavSeconds', () => {
  it('reads the duration from the container', () => {
    expect(wavSeconds(wav(16000, 16000))).toBeCloseTo(1, 5);
    expect(wavSeconds(wav(48000, 24000))).toBeCloseTo(0.5, 5);
  });

  it('trusts what is present over an overlong declared data size', () => {
    const bytes = wav(16000, 16000);
    new DataView(bytes.buffer).setUint32(40, 999_999, true);
    expect(wavSeconds(bytes)).toBeCloseTo(1, 5);
  });

  it('returns zero for something that is not a WAV', () => {
    expect(wavSeconds(new Uint8Array(128))).toBe(0);
    expect(wavSeconds(new Uint8Array(4))).toBe(0);
  });
});

describe('estimateCostUsd', () => {
  it('prices an hour of audio at the list rate', () => {
    expect(estimateCostUsd(3600, 'whisper-large-v3-turbo')).toBeCloseTo(0.04, 6);
    expect(estimateCostUsd(0, 'whisper-large-v3-turbo')).toBe(0);
  });

  it('reports nothing for a model with no list price here', () => {
    // Never 0: that reads as free. A model priced by guesswork would put a
    // number on the dashboard that nobody checked.
    expect(estimateCostUsd(3600, 'whisper-large-v3')).toBeUndefined();
    expect(estimateCostUsd(3600, 'something-new')).toBeUndefined();
  });
});

describe('readRateLimitHeaders', () => {
  it('reads both quotas and keeps the reset intervals verbatim', () => {
    const limit = readRateLimitHeaders(
      new Headers({
        'x-ratelimit-limit-requests': '2000',
        'x-ratelimit-remaining-requests': '1998',
        'x-ratelimit-limit-audio-seconds': '7200',
        'x-ratelimit-remaining-audio-seconds': '7199',
        'x-ratelimit-reset-requests': '1m26.4s',
        'x-ratelimit-reset-audio-seconds': '500ms',
      }),
      '2026-08-04T00:00:00.000Z',
    );
    expect(limit).toEqual({
      limitRequests: 2000,
      remainingRequests: 1998,
      limitAudioSeconds: 7200,
      remainingAudioSeconds: 7199,
      resetRequests: '1m26.4s',
      resetAudioSeconds: '500ms',
      observedAt: '2026-08-04T00:00:00.000Z',
    });
  });

  it('is undefined when the response carried none, so a reading is not overwritten by nothing', () => {
    expect(readRateLimitHeaders(new Headers(), '2026-08-04T00:00:00.000Z')).toBeUndefined();
  });

  it('drops an unparsable count instead of storing NaN', () => {
    const limit = readRateLimitHeaders(
      new Headers({
        'x-ratelimit-limit-requests': 'unlimited',
        'x-ratelimit-remaining-requests': '5',
      }),
      '2026-08-04T00:00:00.000Z',
    );
    expect(limit?.limitRequests).toBeUndefined();
    expect(limit?.remainingRequests).toBe(5);
  });
});

describe('parseStore', () => {
  it('keeps the valid days out of a half-broken file', () => {
    const { days } = parseStore(
      JSON.stringify({
        version: 1,
        days: {
          '2026-08-03': { requests: 3, failures: 0, audioSeconds: 12 },
          '2026-08-04': { requests: 'many' },
          'yesterday': { requests: 1, failures: 0, audioSeconds: 1 },
        },
      }),
    );
    expect([...days.keys()]).toEqual(['2026-08-03']);
  });

  it('reads back the rate-limit snapshot', () => {
    const { rateLimit } = parseStore(
      JSON.stringify({ version: 1, days: {}, rateLimit: { remainingRequests: 7, observedAt: 'x' } }),
    );
    expect(rateLimit?.remainingRequests).toBe(7);
  });
});

describe('buildSummary', () => {
  const now = new Date(2026, 7, 4, 12, 0, 0).getTime(); // 2026-08-04 local

  it('draws a contiguous fortnight ending today', () => {
    const summary = buildSummary(new Map([['2026-08-04', day({ requests: 2 })]]), undefined, now);
    expect(summary.daily).toHaveLength(14);
    expect(summary.daily[0].date).toBe('2026-07-22');
    expect(summary.daily[13].date).toBe('2026-08-04');
    expect(summary.today.requests).toBe(2);
  });

  it('separates a day with no speech from a day nobody was listening', () => {
    const summary = buildSummary(new Map([['2026-08-03', day()]]), undefined, now);
    const observed = summary.daily.find((d) => d.date === '2026-08-03');
    const unseen = summary.daily.find((d) => d.date === '2026-08-02');
    expect(observed?.observed).toBe(true);
    expect(unseen?.observed).toBe(false);
    expect(observed?.requests).toBe(0);
  });

  it('totals only the last seven days, not the whole range', () => {
    const summary = buildSummary(
      new Map([
        ['2026-07-25', day({ requests: 100, audioSeconds: 3600 })], // outside the window
        ['2026-08-01', day({ requests: 5, audioSeconds: 1800, failures: 1 })],
        ['2026-08-04', day({ requests: 3, audioSeconds: 1800 })],
      ]),
      undefined,
      now,
    );
    expect(summary.last7d.requests).toBe(8);
    expect(summary.last7d.failures).toBe(1);
    expect(summary.last7d.audioSeconds).toBe(3600);
    expect(summary.last7d.costUsd).toBeCloseTo(0.04, 6);
  });
});
