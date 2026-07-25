import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { UsageScopedLimit } from '../../../../shared/types';
import { UsageHistoryService } from '../usage-history';

// getHistory reads this fixed path; the service has no injection seam.
const HISTORY_FILE = '/tmp/cchub-usage-history.json';

const snap = (timestamp: string) => ({
  timestamp,
  fiveHour: { utilization: 1, resetsAt: timestamp },
  sevenDay: { utilization: 2, resetsAt: timestamp },
});

describe('UsageHistoryService.getHistory format handling', () => {
  afterEach(async () => {
    await rm(HISTORY_FILE, { force: true });
  });

  test('reads the current array format', async () => {
    await writeFile(HISTORY_FILE, JSON.stringify([snap('2026-01-01T00:00:00.000Z')]));
    const history = await new UsageHistoryService().getHistory();
    expect(history).toHaveLength(1);
  });

  test('reads the legacy { snapshots: [...] } format', async () => {
    await writeFile(
      HISTORY_FILE,
      JSON.stringify({ snapshots: [snap('2026-01-01T00:00:00.000Z'), snap('2026-01-02T00:00:00.000Z')] }),
    );
    const history = await new UsageHistoryService().getHistory();
    expect(history).toHaveLength(2);
  });

  test('drops entries without a timestamp', async () => {
    await writeFile(HISTORY_FILE, JSON.stringify([snap('2026-01-01T00:00:00.000Z'), { bogus: true }]));
    const history = await new UsageHistoryService().getHistory();
    expect(history).toHaveLength(1);
  });

  test('returns [] for unrecognized shapes', async () => {
    await writeFile(HISTORY_FILE, JSON.stringify({ unexpected: 'value' }));
    const history = await new UsageHistoryService().getHistory();
    expect(history).toEqual([]);
  });

  test('keeps snapshots written before scoped limits were tracked', async () => {
    await writeFile(HISTORY_FILE, JSON.stringify([snap('2026-01-01T00:00:00.000Z')]));
    const history = await new UsageHistoryService().getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].scoped).toBeUndefined();
  });
});

describe('UsageHistoryService.recordSnapshot scoped limits', () => {
  const cycle = { utilization: 50, resetsAt: '2026-07-18T05:59:59Z' };
  const fable: UsageScopedLimit = {
    key: 'weekly:Fable',
    name: 'Fable',
    group: 'weekly',
    utilization: 100,
    resetsAt: '2026-07-18T05:59:59Z',
    isActive: true,
    severity: 'critical',
  };

  afterEach(async () => {
    await rm(HISTORY_FILE, { force: true });
  });

  const readSnapshots = async () => JSON.parse(await readFile(HISTORY_FILE, 'utf-8'));

  test('records scoped utilization keyed by limit key', async () => {
    await new UsageHistoryService().recordSnapshot(cycle, cycle, [fable]);
    const [written] = await readSnapshots();
    expect(written.scoped).toEqual({
      'weekly:Fable': { utilization: 100, resetsAt: '2026-07-18T05:59:59Z' },
    });
  });

  // A plan without scoped limits shouldn't pay for an empty object on every
  // snapshot, and readers must be able to tell "not measured" from "0%".
  test.each([
    ['no argument', undefined],
    ['empty array', [] as UsageScopedLimit[]],
  ])('omits the scoped key entirely: %s', async (_label, scoped) => {
    await new UsageHistoryService().recordSnapshot(cycle, cycle, scoped);
    const [written] = await readSnapshots();
    expect('scoped' in written).toBe(false);
  });

  test('appends to history that predates scoped tracking', async () => {
    // Relative, not a literal date: recordSnapshot prunes anything older than
    // 8 days, so a hardcoded timestamp silently turns into "history is empty"
    // once it ages out — and then this asserts the wrong thing forever.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await writeFile(HISTORY_FILE, JSON.stringify([snap(yesterday)]));
    await new UsageHistoryService().recordSnapshot(cycle, cycle, [fable]);
    const written = await readSnapshots();
    expect(written).toHaveLength(2);
    expect(written[0].scoped).toBeUndefined();
    expect(written[1].scoped['weekly:Fable'].utilization).toBe(100);
  });
});
