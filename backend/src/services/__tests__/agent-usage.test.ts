import { describe, expect, test } from 'bun:test';
import { aggregateUsage, CachedUsage, type UsageTurn } from '../agent-usage';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function turn(overrides: Partial<UsageTurn>): UsageTurn {
  return {
    at: NOW - HOUR,
    sessionId: 's1',
    models: ['m1'],
    totalTokens: 100,
    inputTokens: 60,
    outputTokens: 40,
    ...overrides,
  };
}

describe('aggregateUsage', () => {
  test('no turns in the week is null, not a zeroed summary', () => {
    expect(aggregateUsage([], NOW)).toBeNull();
    expect(aggregateUsage([turn({ at: NOW - 8 * 24 * HOUR })], NOW)).toBeNull();
  });

  test('splits the 24h and 7d windows and counts sessions with turns', () => {
    const summary = aggregateUsage(
      [turn({}), turn({ at: NOW - 3 * 24 * HOUR, sessionId: 's2' }), turn({ at: NOW - 9 * 24 * HOUR, sessionId: 's3' })],
      NOW,
    );
    expect(summary?.last24h.turns).toBe(1);
    expect(summary?.last7d.turns).toBe(2);
    expect(summary?.last7d.totalTokens).toBe(200);
    expect(summary?.sessions7d).toBe(2);
    expect(summary?.lastTurnAt).toBe(new Date(NOW - HOUR).toISOString());
  });

  test('a cost is absent until a turn carries one, and a free turn is a real 0', () => {
    expect(aggregateUsage([turn({})], NOW)?.last7d.costUsd).toBeUndefined();
    expect(aggregateUsage([turn({ costUsd: 0 })], NOW)?.last7d.costUsd).toBe(0);
    const summary = aggregateUsage([turn({ costUsd: 0.1 }), turn({ costUsd: 0.2 })], NOW);
    expect(summary?.last7d.costUsd).toBeCloseTo(0.3, 10);
    expect(summary?.models[0].costUsd).toBeCloseTo(0.3, 10);
  });

  test('token kinds an agent does not record stay absent', () => {
    const summary = aggregateUsage([turn({})], NOW);
    expect(summary?.last7d.cacheReadTokens).toBeUndefined();
    expect(summary?.last7d.reasoningTokens).toBeUndefined();
    expect(aggregateUsage([turn({ cacheReadTokens: 5 })], NOW)?.last7d.cacheReadTokens).toBe(5);
  });

  test('models are ranked by tokens, and a multi-model turn counts toward each', () => {
    const summary = aggregateUsage(
      [turn({ models: ['a'], totalTokens: 10 }), turn({ models: ['a', 'b'], totalTokens: 50 }), turn({ models: [] })],
      NOW,
    );
    expect(summary?.models).toEqual([
      { model: 'a', totalTokens: 60 },
      { model: 'b', totalTokens: 50 },
    ]);
  });
});

describe('CachedUsage', () => {
  test('a failing build is null, and is not retried within the TTL', async () => {
    let calls = 0;
    const cached = new CachedUsage('test', () => {
      calls++;
      throw new Error('unreadable');
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(await cached.get()).toBeNull();
      expect(await cached.get()).toBeNull();
    } finally {
      console.error = originalError;
    }
    expect(calls).toBe(1);
  });
});
