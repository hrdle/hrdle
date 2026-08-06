import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leg } from '../dashboard';
import { StatsService } from '../../services/stats-service';
import { findRolloutCandidates } from '../../services/codex-usage';

/**
 * The dashboard is a dozen independent readings gathered with `Promise.all`,
 * which rejects on the first member to reject. `staleWhileRevalidate` in front
 * of it only serves a stale value once it has one, so a single throwing reading
 * takes down `GET /api/dashboard` entirely on the first build after a restart -
 * and keeps taking it down, because a failed build caches nothing.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best effort: the permission test may have left it unreadable
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-test-'));
  dirs.push(dir);
  return dir;
}

describe('leg', () => {
  test('passes a value through untouched', async () => {
    expect(await leg('ok', () => Promise.resolve(42), 0)).toBe(42);
  });

  test('a rejecting reading degrades to its own fallback', async () => {
    expect(await leg('boom', () => Promise.reject(new Error('nope')), null)).toBeNull();
    expect(await leg('boom', () => Promise.reject(new Error('nope')), [])).toEqual([]);
  });

  /**
   * The thunk matters: a service that throws synchronously would otherwise
   * escape before `Promise.all` is even formed, so no per-member catch could
   * see it.
   */
  test('a synchronous throw is caught too', async () => {
    expect(await leg('sync boom', () => { throw new Error('immediate'); }, 'fallback')).toBe('fallback');
  });

  test('one failing reading does not take the others with it', async () => {
    const results = await Promise.all([
      leg('a', () => Promise.resolve('a'), null),
      leg('b', () => Promise.reject(new Error('b failed')), null),
      leg('c', () => Promise.resolve('c'), null),
    ]);
    expect(results).toEqual(['a', null, 'c']);
  });
});

describe('StatsService.getDailyActivity', () => {
  function withCache(contents: string): StatsService {
    const dir = tempDir();
    writeFileSync(join(dir, 'stats-cache.json'), contents);
    return new StatsService(dir);
  }

  test('reads a well-formed cache', async () => {
    const service = withCache(JSON.stringify({
      dailyActivity: [{ date: '2026-08-06', messageCount: 3, sessionCount: 1, toolCallCount: 2 }],
    }));
    const activity = await service.getDailyActivity(14);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.messageCount).toBe(3);
  });

  /**
   * The cache is written by another program and parsed without validation, so
   * a present `dailyActivity` says nothing about it being a list. Truthiness
   * alone let a half-written or reformatted file reach `.slice` and throw.
   */
  test('a malformed cache is no data rather than a throw', async () => {
    for (const body of [
      '{"dailyActivity": 5}',
      '{"dailyActivity": {"2026-08-06": 3}}',
      '{"dailyActivity": "yesterday"}',
      '{"dailyActivity": true}',
    ]) {
      expect(await withCache(body).getDailyActivity(14)).toEqual([]);
    }
  });

  test('unparseable JSON and a missing file are both no data', async () => {
    expect(await withCache('{ not json').getDailyActivity(14)).toEqual([]);
    expect(await new StatsService(tempDir()).getDailyActivity(14)).toEqual([]);
  });
});

describe('findRolloutCandidates', () => {
  test('finds a rollout in the dated layout', () => {
    const dir = tempDir();
    const dayDir = join(dir, '2026', '08', '06');
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, 'rollout-abc.jsonl'), '{}\n');
    expect(findRolloutCandidates(dir, 10)).toHaveLength(1);
  });

  test('a missing directory is empty', () => {
    expect(findRolloutCandidates(join(tempDir(), 'nope'), 10)).toEqual([]);
  });

  /**
   * `existsSync` answers "was there a moment ago", not "is readable now". Every
   * level below this one was already guarded; the top level was not, so an
   * unreadable sessions directory threw out of the whole dashboard build.
   */
  test('an unreadable directory is empty rather than a throw', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '2026'), { recursive: true });
    chmodSync(dir, 0o000);
    expect(findRolloutCandidates(dir, 10)).toEqual([]);
  });

  test('a plain file where the directory should be is empty', () => {
    const dir = tempDir();
    const notADir = join(dir, 'sessions');
    writeFileSync(notADir, 'i am a file');
    expect(findRolloutCandidates(notADir, 10)).toEqual([]);
  });
});
