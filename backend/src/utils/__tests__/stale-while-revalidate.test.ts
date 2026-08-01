import { describe, expect, test } from 'bun:test';
import { staleWhileRevalidate } from '../stale-while-revalidate';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('staleWhileRevalidate', () => {
  test('the first caller waits and gets a fresh value', async () => {
    let builds = 0;
    const cache = staleWhileRevalidate(async () => ++builds, 50);

    expect(await cache.get()).toEqual({ value: 1, stale: false });
    expect(builds).toBe(1);
  });

  test('serves the cached value without rebuilding inside the TTL', async () => {
    let builds = 0;
    const cache = staleWhileRevalidate(async () => ++builds, 1000);

    await cache.get();
    expect(await cache.get()).toEqual({ value: 1, stale: false });
    expect(builds).toBe(1);
  });

  test('past the TTL it answers from cache and rebuilds behind the answer', async () => {
    let builds = 0;
    // TTL comfortably longer than a build, so the refreshed entry lands fresh
    // rather than already lapsed.
    const cache = staleWhileRevalidate(async () => {
      await tick(30);
      return ++builds;
    }, 100);

    await cache.get();
    await tick(110);

    // The point of the whole thing: this returns without waiting the 30ms the
    // rebuild takes, and says so.
    const started = Date.now();
    expect(await cache.get()).toEqual({ value: 1, stale: true });
    expect(Date.now() - started).toBeLessThan(20);

    await tick(50);
    expect(await cache.get()).toEqual({ value: 2, stale: false });
    expect(builds).toBe(2);
  });

  test('concurrent cold callers share one build', async () => {
    let builds = 0;
    const cache = staleWhileRevalidate(async () => {
      await tick(20);
      return ++builds;
    }, 1000);

    const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(results.map((r) => r.value)).toEqual([1, 1, 1]);
    expect(builds).toBe(1);
  });

  test('a failed background rebuild leaves the last good value in place', async () => {
    let builds = 0;
    const cache = staleWhileRevalidate(async () => {
      builds++;
      if (builds > 1) throw new Error('upstream down');
      return 'good';
    }, 10);

    await cache.get();
    await tick(20);

    // Stale beats an error for something a user is only glancing at.
    expect(await cache.get()).toEqual({ value: 'good', stale: true });
    await tick(10);
    expect(await cache.get()).toEqual({ value: 'good', stale: true });
    expect(builds).toBeGreaterThan(1);
  });

  test('a cold build that throws propagates — there is nothing to serve', async () => {
    const cache = staleWhileRevalidate(async () => {
      throw new Error('upstream down');
    }, 10);

    expect(cache.get()).rejects.toThrow('upstream down');
  });

  test('invalidate makes the next call rebuild and wait', async () => {
    let builds = 0;
    const cache = staleWhileRevalidate(async () => ++builds, 1000);

    await cache.get();
    cache.invalidate();
    expect(await cache.get()).toEqual({ value: 2, stale: false });
  });
});
