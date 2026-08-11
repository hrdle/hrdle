import { describe, test, expect } from 'bun:test';
import { ClaudeCodeService } from '../claude-code';

// Verify the cache eviction policy directly via the static helper that
// ClaudeCodeService uses to bound its long-lived per-instance Maps.
//
// We reach the private static through a typed alias purely for testability;
// the runtime contract (TTL sweep + size cap) is the public guarantee.
const evictAndCap = (
  ClaudeCodeService as unknown as {
    evictAndCap: <V extends { timestamp: number }>(cache: Map<string, V>, ttlMs: number) => void;
  }
).evictAndCap;
const CAP = (ClaudeCodeService as unknown as { CACHE_MAX_ENTRIES: number }).CACHE_MAX_ENTRIES;

describe('ClaudeCodeService.evictAndCap', () => {
  test('TTL sweep removes expired entries', () => {
    const m = new Map<string, { timestamp: number }>();
    const now = Date.now();
    m.set('old', { timestamp: now - 60_000 });
    m.set('fresh', { timestamp: now - 1_000 });
    evictAndCap(m, 5_000);
    expect(m.has('old')).toBe(false);
    expect(m.has('fresh')).toBe(true);
  });

  test('does not evict any fresh entries when none are expired', () => {
    const m = new Map<string, { timestamp: number }>();
    const now = Date.now();
    for (let i = 0; i < 50; i++) m.set(`k${i}`, { timestamp: now });
    evictAndCap(m, 60_000);
    expect(m.size).toBe(50);
  });

  test('hard cap evicts oldest (Map insertion order) when over capacity', () => {
    const m = new Map<string, { timestamp: number }>();
    const now = Date.now();
    for (let i = 0; i < CAP + 25; i++) m.set(`k${i}`, { timestamp: now });
    evictAndCap(m, 60_000);
    expect(m.size).toBeLessThanOrEqual(CAP);
    // First 25 entries should be evicted (FIFO).
    for (let i = 0; i < 25; i++) expect(m.has(`k${i}`)).toBe(false);
    expect(m.has(`k${CAP + 24}`)).toBe(true);
  });

  test('combines TTL sweep then hard-cap eviction', () => {
    const m = new Map<string, { timestamp: number }>();
    const now = Date.now();
    // 100 expired, then CAP fresh
    for (let i = 0; i < 100; i++) m.set(`old${i}`, { timestamp: now - 60_000 });
    for (let i = 0; i < CAP; i++) m.set(`new${i}`, { timestamp: now });
    evictAndCap(m, 5_000);
    expect(m.size).toBe(CAP);
    expect(m.has('old0')).toBe(false);
    expect(m.has('new0')).toBe(true);
  });

  test('empty cache is a no-op', () => {
    const m = new Map<string, { timestamp: number }>();
    evictAndCap(m, 1_000);
    expect(m.size).toBe(0);
  });
});
