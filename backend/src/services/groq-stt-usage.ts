import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GroqSttRateLimit, GroqSttUsageDay, GroqSttUsageSummary } from '../../../shared/types';
import { atomicWriteFile, createMutationLock, ensureDataDir } from '../utils/storage';
import { DEFAULT_STT_MODEL, resolveSttModel } from './glasses-settings';
import { localDateKey, startOfDayBefore } from './kimi-usage';

/**
 * How much of Groq's transcription quota the glasses have been spending.
 *
 * Unlike every other usage service here, this one cannot read its history back
 * from anywhere. Kimi, Codex and Grok all leave transcripts on disk that can be
 * re-aggregated after the fact; Groq is a remote API with no usage endpoint,
 * and a request that was not recorded as it happened is gone. So the recording
 * is the source of truth, written on the way past in `routes/glasses.ts`, and
 * this file is the only copy.
 *
 * Two different things are tracked because they are the two things that can run
 * out, and they run out on different clocks:
 *
 * - **Requests**, capped per day (2000 on the free tier).
 * - **Audio seconds**, capped per hour (7200 there) - and also what the API is
 *   priced on, so this is what an estimated cost is computed from.
 *
 * Both ceilings are reported by Groq in `x-ratelimit-*` response headers rather
 * than by any account API, which is why the remaining-quota snapshot is taken
 * from the last real transcription instead of polled: asking would itself cost
 * a request.
 */

const STORE_FILE = 'groq-stt-usage.json';
const STORE_VERSION = 1;
/** Roughly a year, matching the Kimi history file. A day is ~60 bytes. */
const RETAIN_DAYS = 400;
/** Days of history the summary carries. Two weeks is what the chart shows. */
const SUMMARY_DAYS = 14;

/**
 * List price per hour of audio, USD, by model. A local estimate, like
 * `KimiUsageWindow.costUsd`: Groq bills on its own rounding and this server
 * never sees the invoice.
 *
 * Only the model this ran on before the model became a setting has a rate
 * here. A model with no entry reports no cost rather than a guessed one - a
 * wrong number on the dashboard is worse than a blank, because nothing about
 * it says it was never checked.
 */
const USD_PER_AUDIO_HOUR: Record<string, number> = {
  'whisper-large-v3-turbo': 0.04,
};

export interface StoredSttDay {
  requests: number;
  /** Requests Groq rejected or that never reached it. Included in `requests`. */
  failures: number;
  audioSeconds: number;
}

interface StoreFile {
  version: number;
  /** Keyed by local `YYYY-MM-DD`. Presence means the day was observed. */
  days: Record<string, StoredSttDay>;
  /** The most recent `x-ratelimit-*` reading, whichever day it came from. */
  rateLimit?: GroqSttRateLimit;
}

const withStoreLock = createMutationLock();

function isStoredDay(value: unknown): value is StoredSttDay {
  if (typeof value !== 'object' || value === null) return false;
  const day = value as Record<string, unknown>;
  return (
    typeof day.requests === 'number' &&
    typeof day.failures === 'number' &&
    typeof day.audioSeconds === 'number'
  );
}

export function parseStore(text: string): {
  days: Map<string, StoredSttDay>;
  rateLimit?: GroqSttRateLimit;
} {
  const days = new Map<string, StoredSttDay>();
  const parsed = JSON.parse(text) as Partial<StoreFile>;
  if (!parsed || typeof parsed !== 'object') return { days };
  for (const [date, day] of Object.entries(parsed.days ?? {})) {
    // A hand-edited or half-written file costs the days it broke, not the file.
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isStoredDay(day)) {
      days.set(date, {
        requests: day.requests,
        failures: day.failures,
        audioSeconds: day.audioSeconds,
      });
    }
  }
  return { days, rateLimit: parsed.rateLimit };
}

/**
 * Groq reports its reset intervals as Go durations (`1m26.4s`, `500ms`), which
 * are for a human to read rather than a chart to plot - kept verbatim.
 */
export function readRateLimitHeaders(headers: Headers, at: string): GroqSttRateLimit | undefined {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const limit: GroqSttRateLimit = {
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    limitAudioSeconds: num('x-ratelimit-limit-audio-seconds'),
    remainingAudioSeconds: num('x-ratelimit-remaining-audio-seconds'),
    resetRequests: headers.get('x-ratelimit-reset-requests') ?? undefined,
    resetAudioSeconds: headers.get('x-ratelimit-reset-audio-seconds') ?? undefined,
    observedAt: at,
  };
  // A response carrying none of them says nothing; storing it would only push
  // out a reading that did.
  const hasAny = Object.entries(limit).some(([key, value]) => key !== 'observedAt' && value !== undefined);
  return hasAny ? limit : undefined;
}

/** Seconds of 16-bit mono PCM in a byte count. */
export function pcmSeconds(byteLength: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  return byteLength / (sampleRate * 2);
}

/**
 * Seconds of audio in a WAV container, by walking its chunks for the byte rate
 * and the data length.
 *
 * Zero for anything that is not a plain PCM WAV. The glasses send raw PCM and
 * the simulator sends what `MediaRecorder` produced, so a body arriving as
 * `?format=wav` is not guaranteed to be one - and a guessed duration would be
 * spent as real money on the cost estimate.
 */
export function wavSeconds(bytes: Uint8Array): number {
  const ascii = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (bytes.length < 44 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 8 + 16 <= bytes.length) {
      byteRate = view.getUint32(offset + 16, true);
    } else if (id === 'data') {
      // A streamed WAV can carry a zero or overlong data size; what is actually
      // there is the honest number.
      const actual = Math.min(size, bytes.length - offset - 8);
      return byteRate > 0 ? actual / byteRate : 0;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  return 0;
}

/** Undefined for a model with no list price here - never 0, which reads as free. */
export function estimateCostUsd(audioSeconds: number, model: string): number | undefined {
  const rate = USD_PER_AUDIO_HOUR[model];
  if (rate === undefined) return undefined;
  return Math.round((audioSeconds / 3600) * rate * 10_000) / 10_000;
}

function emptyDay(): StoredSttDay {
  return { requests: 0, failures: 0, audioSeconds: 0 };
}

export interface SttRequestOutcome {
  /** Length of the audio sent, in seconds. Zero when it could not be measured. */
  audioSeconds: number;
  ok: boolean;
  rateLimit?: GroqSttRateLimit;
}

export class GroqSttUsageService {
  private days: Map<string, StoredSttDay> | null = null;
  private rateLimit?: GroqSttRateLimit;

  private async load(): Promise<Map<string, StoredSttDay>> {
    if (this.days) return this.days;
    try {
      const parsed = parseStore(await readFile(join(await ensureDataDir(), STORE_FILE), 'utf-8'));
      this.days = parsed.days;
      this.rateLimit = parsed.rateLimit;
    } catch {
      // No file yet, or an unreadable one. History starts from now - there is
      // nowhere else it could be recovered from.
      this.days = new Map();
    }
    return this.days;
  }

  /**
   * Add one transcription to today's tally and persist.
   *
   * Writing per request rather than on a timer: the volume is a few hundred
   * requests a day at most, and a tally held only in memory would lose the
   * day's speech to a restart - which, for the one usage figure that cannot be
   * recomputed, is the whole record.
   */
  async record(outcome: SttRequestOutcome): Promise<void> {
    await withStoreLock(async () => {
      const days = await this.load();
      const date = localDateKey(Date.now());
      const day = days.get(date) ?? emptyDay();
      days.set(date, {
        requests: day.requests + 1,
        failures: day.failures + (outcome.ok ? 0 : 1),
        audioSeconds: day.audioSeconds + outcome.audioSeconds,
      });
      if (outcome.rateLimit) this.rateLimit = outcome.rateLimit;
      for (const key of [...days.keys()]) {
        if (key < localDateKey(startOfDayBefore(Date.now(), RETAIN_DAYS - 1))) days.delete(key);
      }
      const file: StoreFile = {
        version: STORE_VERSION,
        days: Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b))),
        rateLimit: this.rateLimit,
      };
      try {
        await atomicWriteFile(
          join(await ensureDataDir(), STORE_FILE),
          JSON.stringify(file, null, 2),
        );
      } catch (err) {
        // Losing a request from the tally is not worth failing a transcription
        // the user is waiting on.
        console.warn('[groq-stt] failed to persist usage:', err);
      }
    });
  }

  /**
   * Null when nothing was ever recorded: a card reading "0 requests" would say
   * the glasses were used and said nothing, when in fact they were never used
   * on this server at all.
   */
  async getUsageSummary(now = Date.now()): Promise<GroqSttUsageSummary | null> {
    const days = await this.load();
    if (days.size === 0) return null;
    // The model in force now, not a constant: it is a setting, and the card
    // that names it would otherwise keep naming the one it used to be.
    const { model } = await resolveSttModel();
    return buildSummary(days, this.rateLimit, now, model);
  }
}

/**
 * One instance for the process: the STT route writes to it and the dashboard
 * reads from it, and the last rate-limit reading lives in memory between them.
 */
export const groqSttUsageService = new GroqSttUsageService();

/**
 * Contiguous days, oldest first, today last - a quiet day is a bar of height
 * zero rather than a missing column. `observed` separates a day this server
 * watched and saw nothing from one it was not running for.
 */
export function buildSummary(
  days: Map<string, StoredSttDay>,
  rateLimit: GroqSttRateLimit | undefined,
  now: number,
  model: string = DEFAULT_STT_MODEL,
): GroqSttUsageSummary {
  const daily: GroqSttUsageDay[] = [];
  for (let i = SUMMARY_DAYS - 1; i >= 0; i--) {
    const date = localDateKey(startOfDayBefore(now, i));
    const day = days.get(date);
    daily.push({
      date,
      requests: day?.requests ?? 0,
      failures: day?.failures ?? 0,
      audioSeconds: Math.round(day?.audioSeconds ?? 0),
      costUsd: estimateCostUsd(day?.audioSeconds ?? 0, model),
      observed: day !== undefined,
    });
  }

  const today = daily[daily.length - 1];
  const last7 = daily.slice(-7);
  const sum = (pick: (d: GroqSttUsageDay) => number) =>
    last7.reduce((total, day) => total + pick(day), 0);
  const audioSeconds7d = sum((d) => d.audioSeconds);

  return {
    model,
    today: {
      requests: today.requests,
      failures: today.failures,
      audioSeconds: today.audioSeconds,
      costUsd: today.costUsd,
    },
    last7d: {
      requests: sum((d) => d.requests),
      failures: sum((d) => d.failures),
      audioSeconds: audioSeconds7d,
      costUsd: estimateCostUsd(audioSeconds7d, model),
    },
    daily,
    rateLimit,
  };
}
