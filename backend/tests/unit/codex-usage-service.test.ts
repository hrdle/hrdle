import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexUsageService } from '../../src/services/codex-usage';

function makeRolloutLine(overrides: {
  rate_limits: unknown;
  timestamp?: string;
}): string {
  return JSON.stringify({
    timestamp: overrides.timestamp ?? '2026-05-07T09:47:35.877Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: overrides.rate_limits,
    },
  });
}

let scratch: string;
let sessionsDir: string;

function placeRollout(relativeDir: string, fileName: string, lines: string[]): void {
  const dir = join(sessionsDir, relativeDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, `${lines.join('\n')}\n`);
}

describe('CodexUsageService', () => {
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hrdle-codex-usage-'));
    sessionsDir = join(scratch, 'sessions');
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test('returns null when sessions dir is missing', () => {
    const svc = new CodexUsageService(join(scratch, 'missing'));
    expect(svc.computeUsageLimits()).toBeNull();
  });

  test('returns null when no rollout has rate_limits', () => {
    placeRollout('2026/05/07', 'rollout-2026-05-07T09-47-05-aaa.jsonl', [
      JSON.stringify({ timestamp: '2026-05-07T09:47:30Z', type: 'session_meta', payload: {} }),
    ]);
    const svc = new CodexUsageService(sessionsDir);
    expect(svc.computeUsageLimits()).toBeNull();
  });

  test('reads 7-day window from primary on free plan', () => {
    const resetsAtSec = Math.floor(Date.UTC(2026, 4, 14, 0, 0, 0) / 1000);
    placeRollout('2026/05/07', 'rollout-2026-05-07T09-47-05-aaa.jsonl', [
      makeRolloutLine({
        rate_limits: {
          primary: { used_percent: 5.0, window_minutes: 10080, resets_at: resetsAtSec },
          secondary: null,
          plan_type: 'free',
        },
      }),
    ]);

    const svc = new CodexUsageService(sessionsDir);
    const result = svc.computeUsageLimits(Date.UTC(2026, 4, 7, 9, 47, 35));
    expect(result).not.toBeNull();
    expect(result?.planType).toBe('free');
    expect(result?.fiveHour).toBeUndefined();
    expect(result?.sevenDay?.utilization).toBe(5.0);
    expect(result?.sevenDay?.resetsAt).toBe(new Date(resetsAtSec * 1000).toISOString());
    expect(result?.sevenDay?.status).toBe('safe');
  });

  test('classifies 5h and 7d windows when both present', () => {
    const fiveHourReset = Math.floor(Date.UTC(2026, 4, 7, 14, 0, 0) / 1000);
    const sevenDayReset = Math.floor(Date.UTC(2026, 4, 14, 0, 0, 0) / 1000);
    placeRollout('2026/05/07', 'rollout-2026-05-07T09-47-05-aaa.jsonl', [
      makeRolloutLine({
        rate_limits: {
          primary: { used_percent: 80.0, window_minutes: 300, resets_at: fiveHourReset },
          secondary: { used_percent: 30.0, window_minutes: 10080, resets_at: sevenDayReset },
          plan_type: 'plus',
        },
      }),
    ]);

    const svc = new CodexUsageService(sessionsDir);
    const result = svc.computeUsageLimits(Date.UTC(2026, 4, 7, 9, 47, 35));
    expect(result?.fiveHour?.utilization).toBe(80.0);
    // 80% used 47m into a 5h cycle projects to 100% well before reset, so the
    // status should be `danger` (matches the chart's hit-time marker).
    expect(result?.fiveHour?.status).toBe('danger');
    expect(result?.fiveHour?.estimatedHitTime).toBeDefined();
    expect(result?.sevenDay?.utilization).toBe(30.0);
    expect(result?.planType).toBe('plus');
  });

  test('keeps status safe when current pace will reset before hitting the limit', () => {
    // 1% used 4 hours into a 5h cycle. Pace projects far past reset → safe.
    const fiveHourReset = Math.floor(Date.UTC(2026, 4, 7, 14, 0, 0) / 1000);
    placeRollout('2026/05/07', 'rollout-2026-05-07T09-47-05-aaa.jsonl', [
      makeRolloutLine({
        rate_limits: {
          primary: { used_percent: 1.0, window_minutes: 300, resets_at: fiveHourReset },
          secondary: null,
          plan_type: 'plus',
        },
      }),
    ]);
    const svc = new CodexUsageService(sessionsDir);
    const result = svc.computeUsageLimits(Date.UTC(2026, 4, 7, 13, 0, 0));
    expect(result?.fiveHour?.utilization).toBe(1.0);
    expect(result?.fiveHour?.status).toBe('safe');
    expect(result?.fiveHour?.estimatedHitTime).toBeUndefined();
  });

  test('walks back through older rollouts when newest has no rate_limits', () => {
    const resetsAtSec = Math.floor(Date.UTC(2026, 4, 14, 0, 0, 0) / 1000);
    // Newer file: no rate_limits
    placeRollout('2026/05/07', 'rollout-2026-05-07T10-00-00-zzz.jsonl', [
      JSON.stringify({ timestamp: '2026-05-07T10:00:00Z', type: 'session_meta', payload: {} }),
    ]);
    // Older file with rate_limits
    placeRollout('2026/05/06', 'rollout-2026-05-06T09-00-00-aaa.jsonl', [
      makeRolloutLine({
        timestamp: '2026-05-06T09:00:00Z',
        rate_limits: {
          primary: { used_percent: 12.5, window_minutes: 10080, resets_at: resetsAtSec },
          secondary: null,
          plan_type: 'free',
        },
      }),
    ]);

    const svc = new CodexUsageService(sessionsDir);
    const result = svc.computeUsageLimits(Date.UTC(2026, 4, 7, 10, 0, 0));
    expect(result?.sevenDay?.utilization).toBe(12.5);
    expect(result?.capturedAt).toBe('2026-05-06T09:00:00Z');
  });

  test('marks rate limit exceeded when latest event reports an explicit reached type', () => {
    const fiveHourReset = Math.floor(Date.UTC(2026, 4, 7, 16, 48, 0) / 1000);
    const sevenDayReset = Math.floor(Date.UTC(2026, 4, 14, 11, 48, 0) / 1000);
    placeRollout('2026/05/07', 'rollout-2026-05-07T09-47-05-aaa.jsonl', [
      // Older event with populated windows (so we still chart something)
      makeRolloutLine({
        timestamp: '2026-05-07T12:21:17Z',
        rate_limits: {
          primary: { used_percent: 75.0, window_minutes: 300, resets_at: fiveHourReset },
          secondary: { used_percent: 12.0, window_minutes: 10080, resets_at: sevenDayReset },
          plan_type: 'plus',
        },
      }),
      // Newer event after exhaustion: windows null with an explicit verdict
      makeRolloutLine({
        timestamp: '2026-05-07T14:03:01Z',
        rate_limits: {
          primary: null,
          secondary: null,
          credits: { has_credits: false, unlimited: false, balance: '0' },
          rate_limit_reached_type: 'rate_limit_reached',
          plan_type: null,
        },
      }),
    ]);

    const svc = new CodexUsageService(sessionsDir);
    const result = svc.computeUsageLimits(Date.UTC(2026, 4, 7, 14, 5, 0));
    expect(result?.rateLimitExceeded).toBe(true);
    // Preserve the last measured utilization instead of inventing 100%.
    expect(result?.fiveHour?.utilization).toBe(75.0);
    // 7d cycle still reports the last known windowed value
    expect(result?.sevenDay?.utilization).toBe(12.0);
    // capturedAt comes from the latest (exhausted) event
    expect(result?.capturedAt).toBe('2026-05-07T14:03:01Z');
    // planType falls back to the windowed event when latest reports null
    expect(result?.planType).toBe('plus');
  });

  test('does not treat an empty purchased-credit balance as rate-limit exhaustion', () => {
    const sevenDayReset = Math.floor(Date.UTC(2026, 4, 14, 16, 48, 0) / 1000);
    placeRollout('2026/05/07', 'rollout-2026-05-07T09-47-05-aaa.jsonl', [
      makeRolloutLine({
        rate_limits: {
          primary: { used_percent: 9.0, window_minutes: 10080, resets_at: sevenDayReset },
          secondary: null,
          credits: { has_credits: false, unlimited: false, balance: '0' },
          rate_limit_reached_type: null,
          plan_type: 'plus',
        },
      }),
    ]);
    const svc = new CodexUsageService(sessionsDir);
    const result = svc.computeUsageLimits(Date.UTC(2026, 4, 7, 14, 5, 0));
    expect(result?.rateLimitExceeded).toBeUndefined();
    expect(result?.sevenDay?.utilization).toBe(9.0);
  });

  test('does not keep exhaustion after the cycle reset time has passed', () => {
    const fiveHourReset = Math.floor(Date.UTC(2026, 4, 7, 10, 0, 0) / 1000);
    const sevenDayReset = Math.floor(Date.UTC(2026, 4, 14, 0, 0, 0) / 1000);
    placeRollout('2026/05/07', 'rollout-2026-05-07T09-47-05-aaa.jsonl', [
      makeRolloutLine({
        timestamp: '2026-05-07T09:30:00Z',
        rate_limits: {
          primary: { used_percent: 88.0, window_minutes: 300, resets_at: fiveHourReset },
          secondary: { used_percent: 15.0, window_minutes: 10080, resets_at: sevenDayReset },
          plan_type: 'plus',
        },
      }),
      makeRolloutLine({
        timestamp: '2026-05-07T09:35:00Z',
        rate_limits: {
          primary: null,
          secondary: null,
          credits: { has_credits: false, unlimited: false, balance: '0' },
          rate_limit_reached_type: 'rate_limit_reached',
          plan_type: null,
        },
      }),
    ]);

    const svc = new CodexUsageService(sessionsDir);
    const result = svc.computeUsageLimits(Date.UTC(2026, 4, 7, 11, 0, 0));

    expect(result?.rateLimitExceeded).toBeUndefined();
    expect(result?.fiveHour?.utilization).toBe(88.0);
    expect(result?.fiveHour?.status).toBe('warning');
  });

  test('caches results within TTL', async () => {
    const resetsAtSec = Math.floor(Date.UTC(2026, 4, 14, 0, 0, 0) / 1000);
    placeRollout('2026/05/07', 'rollout-2026-05-07T09-47-05-aaa.jsonl', [
      makeRolloutLine({
        rate_limits: {
          primary: { used_percent: 5.0, window_minutes: 10080, resets_at: resetsAtSec },
          secondary: null,
          plan_type: 'free',
        },
      }),
    ]);

    const svc = new CodexUsageService(sessionsDir);
    const first = await svc.getUsageLimits();
    rmSync(scratch, { recursive: true, force: true });
    const second = await svc.getUsageLimits();
    expect(first).toEqual(second);
    expect(second?.sevenDay?.utilization).toBe(5.0);
  });
});
