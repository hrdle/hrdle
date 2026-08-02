import { describe, expect, test } from 'bun:test';
import {
  buildDailySeries,
  type DayAccumulator,
  localDateKey,
  startOfDayBefore,
} from '../kimi-usage';

function day(turns: number, totalTokens: number, usd: number | null): DayAccumulator {
  return {
    turns,
    totalTokens,
    cost: usd === null ? { usd: 0, priced: false } : { usd, priced: true },
  };
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

  test('the oldest chart day is inside the 7-day read the service already does', () => {
    // Why the daily series costs no extra I/O: local midnight six days back is
    // always later than the rolling cutoff seven days back.
    const now = new Date(2026, 7, 2, 0, 5).getTime();
    expect(startOfDayBefore(now, 6)).toBeGreaterThanOrEqual(now - 7 * 24 * 60 * 60 * 1000);
  });
});

describe('buildDailySeries', () => {
  const now = new Date(2026, 7, 2, 15, 0).getTime();

  test('every day in the range is present, oldest first, today last', () => {
    const series = buildDailySeries(new Map(), now, 7);
    expect(series).toHaveLength(7);
    expect(series[0].date).toBe('2026-07-27');
    expect(series[6].date).toBe('2026-08-02');
  });

  test('a day with no usage is a zero bar, not a missing column', () => {
    const series = buildDailySeries(new Map([['2026-08-02', day(3, 1000, 0.42)]]), now, 7);
    // A chart whose gaps close up lies about when the spending happened.
    expect(series.slice(0, 6).every((d) => d.turns === 0 && d.costUsd === 0)).toBe(true);
    expect(series[6]).toEqual({ date: '2026-08-02', turns: 3, totalTokens: 1000, costUsd: 0.42 });
  });

  test('an unpriceable day is unknown, never zero', () => {
    // $0.00 says "you spent nothing"; absent says "we could not price this".
    // Conflating them is how a dashboard quietly under-reports a bill.
    const series = buildDailySeries(new Map([['2026-08-02', day(4, 900, null)]]), now, 7);
    expect(series[6].costUsd).toBeUndefined();
    expect(series[6].turns).toBe(4);
  });

  test('costs keep sub-cent resolution', () => {
    const series = buildDailySeries(new Map([['2026-08-02', day(1, 10, 0.00123456)]]), now, 7);
    expect(series[6].costUsd).toBe(0.0012);
  });

  test('a day outside the range is dropped rather than folded into an edge bar', () => {
    const series = buildDailySeries(new Map([['2026-07-20', day(9, 5000, 3)]]), now, 7);
    expect(series.every((d) => d.turns === 0)).toBe(true);
  });
});
