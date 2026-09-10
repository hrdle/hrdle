import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatsService } from '../../src/services/stats-service';

describe('StatsService', () => {
  // Note: These tests use the actual ~/.claude/stats-cache.json
  // They verify the service works correctly with real or missing data
  const statsService = new StatsService();

  /**
   * A `.claude` of this test's own, holding one transcript.
   *
   * `getModelUsage` walks every transcript under the directory it is given.
   * Pointed at the real one it takes as long as that machine's history is
   * large - 1.9GB over 82 projects timed out at the 5s limit here, while CI's
   * empty home passed - so the suite's result depended on whose machine ran
   * it. A fixture also lets the assertions be about a known answer rather
   * than about whatever happened to be on disk.
   */
  function claudeDirWithTranscript(): string {
    const root = mkdtempSync(join(tmpdir(), 'hrdle-stats-'));
    const project = join(root, 'projects', '-home-someone-work');
    mkdirSync(project, { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-opus-4-5-20251101',
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 33,
          cache_creation_input_tokens: 44,
        },
      },
    };
    writeFileSync(join(project, 'session.jsonl'), `${JSON.stringify(record)}\n`);
    return root;
  }

  describe('getDailyActivity', () => {
    test('should return an array', async () => {
      const activity = await statsService.getDailyActivity();
      expect(Array.isArray(activity)).toBe(true);
    });

    test('should respect limit parameter', async () => {
      const activity = await statsService.getDailyActivity(5);
      expect(activity.length).toBeLessThanOrEqual(5);
    });

    test('should return items with correct structure', async () => {
      const activity = await statsService.getDailyActivity();
      if (activity.length > 0) {
        expect(activity[0]).toHaveProperty('date');
        expect(activity[0]).toHaveProperty('messageCount');
        expect(activity[0]).toHaveProperty('sessionCount');
      }
    });
  });

  describe('getModelUsage', () => {
    test('is empty when there are no transcripts to read', async () => {
      const usage = await new StatsService(mkdtempSync(join(tmpdir(), 'hrdle-stats-'))).getModelUsage();
      expect(usage).toEqual([]);
    });

    test('totals a transcript the window covers, under the model display name', async () => {
      const usage = await new StatsService(claudeDirWithTranscript()).getModelUsage();
      expect(usage).toEqual([
        {
          model: 'Opus 4.5',
          totalTokensIn: 11,
          totalTokensOut: 22,
          totalCacheRead: 33,
          totalCacheWrite: 44,
        },
      ]);
    });
  });

  describe('getModelDisplayName', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing private method
    const displayName = (id: string) => (statsService as any).getModelDisplayName(id);

    test('formats opus/sonnet with dated suffix', () => {
      expect(displayName('claude-opus-4-5-20251101')).toBe('Opus 4.5');
      expect(displayName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    });

    test('formats versions without date suffix', () => {
      expect(displayName('claude-opus-4-6')).toBe('Opus 4.6');
    });

    test('formats haiku and other families', () => {
      expect(displayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
      expect(displayName('claude-fable-5')).toBe('Fable 5');
    });

    test('returns unknown IDs as-is', () => {
      expect(displayName('some-other-model')).toBe('some-other-model');
    });
  });

  describe('getHourlyActivity', () => {
    test('should return an object', async () => {
      const hourly = await statsService.getHourlyActivity();
      expect(typeof hourly).toBe('object');
    });

    test('should return empty object or 24 hours', async () => {
      const hourly = await statsService.getHourlyActivity();
      const keys = Object.keys(hourly);
      // Either empty (no data) or exactly 24 hours
      expect(keys.length === 0 || keys.length === 24).toBe(true);
    });

    test('should have numeric values if data exists', async () => {
      const hourly = await statsService.getHourlyActivity();
      if (Object.keys(hourly).length > 0) {
        for (let i = 0; i < 24; i++) {
          expect(typeof hourly[i]).toBe('number');
        }
      }
    });
  });
});
