import { describe, expect, it } from 'bun:test';
import { paneViewportRows } from '../herdr-control';

/**
 * A pane has no `scroll` until it has a terminal runtime. herdr leaves restored
 * panes runtime-less on purpose: it defers the agent resume until a client
 * attaches with a non-zero size.
 *
 * hrdle used to read a missing `scroll` as "herdr server is older than protocol
 * 16" and refuse the subscribe. That misdiagnosis deadlocked exactly the panes a
 * subscribe exists to revive — no subscribe → no client size → no resume → still
 * no scroll — and blamed a fully up-to-date herdr for it. Version skew has its
 * own accurate source (HerdrUpdateService reads the real protocol number), so a
 * missing scroll must degrade to the client's size rather than throw.
 */
describe('paneViewportRows', () => {
  const scroll = { offset_from_bottom: 0, max_offset_from_bottom: 460, viewport_rows: 23 };

  it('uses the pane rows once a runtime exists', () => {
    expect(paneViewportRows({ scroll }, 40)).toBe(23);
  });

  it('falls back to the client rows on a runtime-less pane instead of throwing', () => {
    expect(paneViewportRows({ scroll: undefined }, 40)).toBe(40);
  });

  // A restored pane awaiting resume is the whole reason this path must not
  // throw: subscribing is what triggers the resume.
  it('lets a restored pane awaiting agent resume be subscribed', () => {
    expect(() => paneViewportRows({ scroll: undefined }, 24)).not.toThrow();
    expect(paneViewportRows({ scroll: undefined }, 24)).toBe(24);
  });

  it('falls back when the runtime reports zero rows', () => {
    expect(paneViewportRows({ scroll: { ...scroll, viewport_rows: 0 } }, 40)).toBe(40);
  });
});
