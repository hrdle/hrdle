import { describe, expect, test } from 'bun:test';
import {
  buildDailySeries,
  buildLiveDays,
  type DayAccumulator,
  localDateKey,
  startOfDayBefore,
} from '../kimi-usage';
import { mergeDays, type StoredDay } from '../kimi-usage-store';

function day(turns: number, totalTokens: number, usd: number | null): DayAccumulator {
  return {
    turns,
    totalTokens,
    cost: usd === null ? { usd: 0, priced: false } : { usd, priced: true },
  };
}

function stored(turns: number, totalTokens: number, costUsd?: number): StoredDay {
  return { turns, totalTokens, costUsd };
}

/**
 * The dashboard's rolling windows cannot answer "what has today cost me" -
 * `last24h` read at 10:00 is mostly yesterday - so the daily series buckets by
 * the day on the wall. Which makes the timezone the whole ballgame.
 */
describe('localDateKey', () => {
  test('files a timestamp under its local day, not its UTC one', () => {
    // 23:30 local on the 2nd. `toISOString().slice(0, 10)` would say the 3rd
    // anywhere east of Greenwich and the 1st far enough west - the bug this
    // function exists to not have.
    const late = new Date(2026, 7, 2, 23, 30).getTime();
    expect(localDateKey(late)).toBe('2026-08-02');

    const early = new Date(2026, 7, 2, 0, 30).getTime();
    expect(localDateKey(early)).toBe('2026-08-02');
  });

  test('months and days are zero-padded so the keys sort', () => {
    // The series relies on string comparison for "is this day older than that
    // one", so an unpadded month would sort 2026-9-01 after 2026-10-01.
    expect(localDateKey(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05');
  });
});

describe('startOfDayBefore', () => {
  test('lands on local midnight', () => {
    const d = new Date(startOfDayBefore(new Date(2026, 7, 2, 17, 45).getTime(), 0));
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0]);
  });

  test('steps whole calendar days back across a month boundary', () => {
    const now = new Date(2026, 7, 2, 9, 0).getTime();
    expect(localDateKey(startOfDayBefore(now, 6))).toBe('2026-07-27');
  });

  test('the oldest live day is inside the 7-day read the service already does', () => {
    // Why the daily series costs no extra I/O: local midnight six days back is
    // always later than the rolling cutoff seven days back.
    const now = new Date(2026, 7, 2, 0, 5).getTime();
    expect(startOfDayBefore(now, 6)).toBeGreaterThanOrEqual(now - 7 * 24 * 60 * 60 * 1000);
  });
});

describe('buildLiveDays', () => {
  const now = new Date(2026, 7, 2, 15, 0).getTime();

  test('every day in the range is present, oldest first, today last', () => {
    const series = buildLiveDays(new Map(), now, 7);
    expect(series).toHaveLength(7);
    expect(series[0].date).toBe('2026-07-27');
    expect(series[6].date).toBe('2026-08-02');
  });

  test('a day with no usage is a zero bar, not a missing column', () => {
    const series = buildLiveDays(new Map([['2026-08-02', day(3, 1000, 0.42)]]), now, 7);
    // A chart whose gaps close up lies about when the spending happened.
    expect(series.slice(0, 6).every((d) => d.turns === 0 && d.costUsd === 0)).toBe(true);
    expect(series[6]).toEqual({
      date: '2026-08-02',
      turns: 3,
      totalTokens: 1000,
      costUsd: 0.42,
      observed: true,
    });
  });

  test('an unpriceable day is unknown, never zero', () => {
    // $0.00 says "you spent nothing"; absent says "we could not price this".
    // Conflating them is how a dashboard quietly under-reports a bill.
    const series = buildLiveDays(new Map([['2026-08-02', day(4, 900, null)]]), now, 7);
    expect(series[6].costUsd).toBeUndefined();
    expect(series[6].turns).toBe(4);
  });

  test('every live day counts as observed, usage or not', () => {
    // The window was read, so a zero here is a fact rather than a blank.
    expect(buildLiveDays(new Map(), now, 7).every((d) => d.observed)).toBe(true);
  });

  test('costs keep sub-cent resolution', () => {
    const series = buildLiveDays(new Map([['2026-08-02', day(1, 10, 0.00123456)]]), now, 7);
    expect(series[6].costUsd).toBe(0.0012);
  });

  test('a day outside the range is dropped rather than folded into an edge bar', () => {
    const series = buildLiveDays(new Map([['2026-07-20', day(9, 5000, 3)]]), now, 7);
    expect(series.every((d) => d.turns === 0)).toBe(true);
  });
});

/**
 * The seven days are all the log files can still answer for. Everything older
 * comes from the history file, which is why the two have to join without a
 * seam - and why a day nobody ever saw must not arrive looking like a quiet
 * one.
 */
describe('buildDailySeries', () => {
  const now = new Date(2026, 7, 2, 15, 0).getTime();
  const live = buildLiveDays(new Map([['2026-08-02', day(3, 1000, 0.5)]]), now, 7);

  test('with no history it is exactly the live week', () => {
    const series = buildDailySeries(new Map(), live, now, 30);
    expect(series).toHaveLength(7);
    expect(series[0].date).toBe('2026-07-27');
    expect(series[6].date).toBe('2026-08-02');
  });

  test('stored days extend the range backwards', () => {
    const history = new Map([
      ['2026-07-25', stored(10, 5000, 2)],
      ['2026-07-26', stored(2, 100, 0.1)],
    ]);
    const series = buildDailySeries(history, live, now, 30);
    expect(series).toHaveLength(9);
    expect(series[0]).toEqual({
      date: '2026-07-25',
      turns: 10,
      totalTokens: 5000,
      costUsd: 2,
      observed: true,
    });
    expect(series[series.length - 1].date).toBe('2026-08-02');
  });

  test('the live reading wins over a stored one for the same day', () => {
    // Both came from the same logs; the one computed a moment ago is the one
    // that saw the whole day.
    const history = new Map([['2026-08-02', stored(1, 1, 0.01)]]);
    const series = buildDailySeries(history, live, now, 30);
    expect(series[series.length - 1].costUsd).toBe(0.5);
  });

  test('a day nobody saw is a hole, not a zero', () => {
    // The server was down for the whole week that day could have been read in.
    // Drawing it as $0 would claim a quiet day that may have been an expensive
    // one.
    const history = new Map([['2026-07-24', stored(5, 500, 1)]]);
    const series = buildDailySeries(history, live, now, 30);
    const gap = series.find((d) => d.date === '2026-07-25');
    expect(gap).toEqual({
      date: '2026-07-25',
      turns: 0,
      totalTokens: 0,
      costUsd: undefined,
      observed: false,
    });
  });

  test('history older than the cap is left out of the chart', () => {
    const history = new Map([['2026-01-01', stored(99, 9999, 50)]]);
    const series = buildDailySeries(history, live, now, 30);
    expect(series[0].date).toBe('2026-07-27');
    expect(series.some((d) => d.date === '2026-01-01')).toBe(false);
  });

  test('the range never starts before the cap even with older history', () => {
    const history = new Map([['2026-06-01', stored(1, 1, 1)]]);
    const series = buildDailySeries(history, live, now, 30);
    expect(series.length).toBeLessThanOrEqual(30);
  });
});

/**
 * The store is written on every dashboard build, so the thing worth pinning is
 * that it mostly decides *not* to write.
 */
describe('mergeDays', () => {
  test('nothing new means no write', () => {
    const disk = new Map([['2026-08-01', stored(3, 100, 0.5)]]);
    const same = new Map([['2026-08-01', stored(3, 100, 0.5)]]);
    expect(mergeDays(disk, same, '2026-01-01')).toBeNull();
  });

  test('a changed figure for a day already on disk is taken', () => {
    const disk = new Map([['2026-08-01', stored(3, 100, 0.5)]]);
    const better = new Map([['2026-08-01', stored(4, 120, 0.6)]]);
    expect(mergeDays(disk, better, '2026-01-01')?.get('2026-08-01')?.costUsd).toBe(0.6);
  });

  test('an unpriced day and a free day are not the same entry', () => {
    const disk = new Map([['2026-08-01', stored(3, 100, undefined)]]);
    const priced = new Map([['2026-08-01', stored(3, 100, 0)]]);
    expect(mergeDays(disk, priced, '2026-01-01')).not.toBeNull();
  });

  test('days past the retention horizon are dropped', () => {
    const disk = new Map([
      ['2025-01-01', stored(1, 1, 1)],
      ['2026-08-01', stored(3, 100, 0.5)],
    ]);
    const merged = mergeDays(disk, new Map(), '2026-01-01');
    expect(merged?.has('2025-01-01')).toBe(false);
    expect(merged?.has('2026-08-01')).toBe(true);
  });
});
