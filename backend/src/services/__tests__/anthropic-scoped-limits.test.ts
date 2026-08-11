import { describe, expect, test } from 'bun:test';
import { parseScopedLimits } from '../anthropic-usage';

// Trimmed from a real GET /api/oauth/usage response (2026-07-16). The flat
// five_hour / seven_day fields still carry the overall cycles; `limits[]` is
// where per-model limits appear.
const REAL_RESPONSE = {
  five_hour: { utilization: 7.0, resets_at: '2026-07-16T01:59:59.799410+00:00' },
  seven_day: { utilization: 68.0, resets_at: '2026-07-18T05:59:59.799432+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 7,
      severity: 'normal',
      resets_at: '2026-07-16T01:59:59.799410+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 68,
      severity: 'normal',
      resets_at: '2026-07-18T05:59:59.799432+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2026-07-18T05:59:59.799770+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
};

describe('parseScopedLimits', () => {
  test('extracts the per-model limit from a real response', () => {
    expect(parseScopedLimits(REAL_RESPONSE)).toEqual([
      {
        key: 'weekly:Fable',
        name: 'Fable',
        group: 'weekly',
        utilization: 100,
        resetsAt: '2026-07-18T05:59:59.799770+00:00',
        isActive: true,
        severity: 'critical',
      },
    ]);
  });

  test('ignores unscoped entries — those are the overall cycles already charted', () => {
    const parsed = parseScopedLimits(REAL_RESPONSE);
    expect(parsed).toHaveLength(1);
    expect(parsed.every((l) => l.name === 'Fable')).toBe(true);
  });

  test('falls back to the surface name when a limit is not scoped to a model', () => {
    const parsed = parseScopedLimits({
      limits: [
        {
          group: 'session',
          percent: 42,
          resets_at: '2026-07-16T01:59:59Z',
          scope: { model: null, surface: 'Claude Code' },
          is_active: false,
        },
      ],
    });
    expect(parsed).toEqual([
      {
        key: 'session:Claude Code',
        name: 'Claude Code',
        group: 'session',
        utilization: 42,
        resetsAt: '2026-07-16T01:59:59Z',
        isActive: false,
        severity: undefined,
      },
    ]);
  });

  // The overlays ride the cycle charts, so a limit on a cycle hrdle doesn't
  // draw has no axis to sit on. Dropping it beats guessing a placement.
  test('drops limits belonging to a cycle that has no chart', () => {
    expect(
      parseScopedLimits({
        limits: [
          {
            group: 'monthly',
            percent: 10,
            resets_at: '2026-08-01T00:00:00Z',
            scope: { model: { display_name: 'Fable' } },
          },
        ],
      }),
    ).toEqual([]);
  });

  test.each([
    ['no limits array', { five_hour: { utilization: 7 } }],
    ['limits is not an array', { limits: 'nope' }],
    ['limits is null', { limits: null }],
    ['null input', null],
    ['undefined input', undefined],
    ['empty array', { limits: [] }],
  ])('degrades to no overlays: %s', (_label, input) => {
    expect(parseScopedLimits(input)).toEqual([]);
  });

  test.each([
    ['null entry', null],
    ['missing percent', { group: 'weekly', resets_at: '2026-07-18T05:59:59Z', scope: { model: { display_name: 'Fable' } } }],
    ['non-numeric percent', { group: 'weekly', percent: '100', resets_at: '2026-07-18T05:59:59Z', scope: { model: { display_name: 'Fable' } } }],
    ['NaN percent', { group: 'weekly', percent: Number.NaN, resets_at: '2026-07-18T05:59:59Z', scope: { model: { display_name: 'Fable' } } }],
    ['missing resets_at', { group: 'weekly', percent: 100, scope: { model: { display_name: 'Fable' } } }],
    ['empty display_name', { group: 'weekly', percent: 100, resets_at: '2026-07-18T05:59:59Z', scope: { model: { display_name: '' } } }],
    ['scope present but empty', { group: 'weekly', percent: 100, resets_at: '2026-07-18T05:59:59Z', scope: {} }],
  ])('skips unusable entry: %s', (_label, entry) => {
    expect(parseScopedLimits({ limits: [entry] })).toEqual([]);
  });

  test('keeps usable entries when a sibling entry is malformed', () => {
    const parsed = parseScopedLimits({
      limits: [
        null,
        { group: 'weekly', percent: 'bad', scope: { model: { display_name: 'Broken' } } },
        {
          group: 'weekly',
          percent: 100,
          severity: 'critical',
          resets_at: '2026-07-18T05:59:59Z',
          scope: { model: { display_name: 'Fable' } },
          is_active: true,
        },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Fable');
  });

  test('keys distinguish the same model across cycles', () => {
    const parsed = parseScopedLimits({
      limits: [
        { group: 'session', percent: 20, resets_at: '2026-07-16T01:00:00Z', scope: { model: { display_name: 'Fable' } } },
        { group: 'weekly', percent: 100, resets_at: '2026-07-18T05:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    });
    expect(parsed.map((l) => l.key)).toEqual(['session:Fable', 'weekly:Fable']);
  });

  test('treats a missing is_active as not active rather than truthy', () => {
    const parsed = parseScopedLimits({
      limits: [
        { group: 'weekly', percent: 100, resets_at: '2026-07-18T05:59:59Z', scope: { model: { display_name: 'Fable' } } },
      ],
    });
    expect(parsed[0].isActive).toBe(false);
  });
});
