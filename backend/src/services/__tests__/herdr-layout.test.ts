import { describe, expect, test } from 'bun:test';
import { paneIdFromLayout } from '../../../../shared/types';
import type { HerdrLayoutNode } from '../herdr-client';
import { toTmuxPaneId } from '../herdr-client';
import { herdrLayoutToNode, PaneLayoutTree } from '../herdr-layout';

function twoPane(): PaneLayoutTree {
  const t = new PaneLayoutTree();
  t.setInitialPanes(['%1']);
  t.split('%1', 'h', '%2');
  return t;
}

describe('PaneLayoutTree.setPaneSize', () => {
  test('sets absolute width via ancestor split ratio', () => {
    const t = twoPane();
    t.setPaneSize('%1', 120, 40, 160, 40);
    const rects = t.computeRects(160, 40);
    expect(rects.get('%1')?.width).toBeCloseTo(120, -1); // within rounding
    expect((rects.get('%1')?.width ?? 0) + (rects.get('%2')?.width ?? 0) + 1).toBe(160);
  });

  test('resize survives a subsequent recompute (single source of truth)', () => {
    const t = twoPane();
    t.setPaneSize('%2', 40, 40, 160, 40);
    // Simulate a later applyLayout pass at the same client size
    const again = t.computeRects(160, 40);
    expect(again.get('%2')?.width).toBeCloseTo(40, -1);
  });

  test('second pane resize adjusts the shared split consistently', () => {
    const t = twoPane();
    t.setPaneSize('%2', 100, 40, 160, 40);
    const rects = t.computeRects(160, 40);
    expect(rects.get('%2')?.width).toBeCloseTo(100, -1);
    expect(rects.get('%1')?.width).toBeCloseTo(59, -1);
  });

  test('vertical dimension uses v-split ancestor', () => {
    const t = new PaneLayoutTree();
    t.setInitialPanes(['%1']);
    t.split('%1', 'v', '%2');
    t.setPaneSize('%1', 160, 30, 160, 40);
    const rects = t.computeRects(160, 40);
    expect(rects.get('%1')?.height).toBeCloseTo(30, -1);
  });

  test('nested split: resizing inner pane keeps outer split intact', () => {
    const t = new PaneLayoutTree();
    t.setInitialPanes(['%1']);
    t.split('%1', 'h', '%2'); // [%1 | %2]
    t.split('%2', 'v', '%3'); // right column: %2 over %3
    t.setPaneSize('%3', 79, 10, 160, 40);
    const rects = t.computeRects(160, 40);
    expect(rects.get('%3')?.height).toBeCloseTo(10, -1);
    // outer h-split untouched: right column still ~half width
    expect(rects.get('%3')?.width).toBeCloseTo(79, -1);
    expect(rects.get('%1')?.width).toBeCloseTo(80, -1);
  });

  test('ratio is clamped so a pane cannot be sized away entirely', () => {
    const t = twoPane();
    t.setPaneSize('%1', 1000, 40, 160, 40);
    const rects = t.computeRects(160, 40);
    expect(rects.get('%2')?.width ?? 0).toBeGreaterThanOrEqual(15); // >= 10% of usable
  });
});

describe('herdrLayoutToNode', () => {
  test('a single pane becomes a single leaf', () => {
    const node: HerdrLayoutNode = { type: 'pane', pane_id: 'w1:p1' };
    expect(herdrLayoutToNode(node, toTmuxPaneId)).toEqual({ type: 'leaf', paneId: '%1' });
  });

  test('right split maps to h, down split maps to v; first/second become a/b', () => {
    const right: HerdrLayoutNode = {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'w1:p1' },
      second: { type: 'pane', pane_id: 'w1:p2' },
    };
    expect(herdrLayoutToNode(right, toTmuxPaneId)).toEqual({
      type: 'split',
      dir: 'h',
      ratio: 0.5,
      a: { type: 'leaf', paneId: '%1' },
      b: { type: 'leaf', paneId: '%2' },
    });

    const down: HerdrLayoutNode = { ...right, direction: 'down' };
    expect(herdrLayoutToNode(down, toTmuxPaneId)).toMatchObject({ dir: 'v' });
  });

  test('reconstructs the nested tree herdr actually exports', () => {
    // The exact shape observed from a live `layout.export`: split right {p1,
    // split down {p2, p3}} — p1 on the left, p2 over p3 on the right.
    const exported: HerdrLayoutNode = {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'w10:p1' },
      second: {
        type: 'split',
        direction: 'down',
        ratio: 0.5,
        first: { type: 'pane', pane_id: 'w10:p2' },
        second: { type: 'pane', pane_id: 'w10:p3' },
      },
    };
    const root = herdrLayoutToNode(exported, toTmuxPaneId);
    expect(root).not.toBeNull();

    const t = new PaneLayoutTree();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    t.setInitialTree(root!);
    expect(t.paneIds().sort()).toEqual(['%1', '%2', '%3']);

    const rects = t.computeRects(160, 40);
    // %1 is the whole left half; %2/%3 stack in the right half.
    expect(rects.get('%1')?.height).toBe(40);
    expect(rects.get('%2')?.x).toBe(rects.get('%3')?.x); // same column
    expect((rects.get('%2')?.height ?? 0) + (rects.get('%3')?.height ?? 0)).toBeLessThan(40);
  });

  test('an unmappable pane id anywhere collapses the whole tree to null', () => {
    const bad: HerdrLayoutNode = {
      type: 'split',
      direction: 'right',
      ratio: 0.5,
      first: { type: 'pane', pane_id: 'w1:p1' },
      second: { type: 'pane', pane_id: 'not-a-herdr-id' },
    };
    expect(herdrLayoutToNode(bad, toTmuxPaneId)).toBeNull();
  });

  test('ratio is clamped into the tree\'s valid range', () => {
    const hi: HerdrLayoutNode = {
      type: 'split',
      direction: 'right',
      ratio: 0.99,
      first: { type: 'pane', pane_id: 'w1:p1' },
      second: { type: 'pane', pane_id: 'w1:p2' },
    };
    const lo: HerdrLayoutNode = { ...hi, ratio: 0.01 };
    expect((herdrLayoutToNode(hi, toTmuxPaneId) as { ratio: number }).ratio).toBeCloseTo(0.9);
    expect((herdrLayoutToNode(lo, toTmuxPaneId) as { ratio: number }).ratio).toBeCloseTo(0.1);
  });
});

describe('PaneLayoutTree.setSplitRatio', () => {
	test('sets the ratio of a simple two-pane split', () => {
		const t = twoPane(); // h[%1, %2]
		expect(t.setSplitRatio('%1', '%2', 'h', 0.25)).toBe(true);
		const rects = t.computeRects(161, 40); // usable 160
		expect(rects.get('%1')?.width).toBeCloseTo(40, -1);
	});

	test('reversed pane order inverts the share', () => {
		const t = twoPane();
		expect(t.setSplitRatio('%2', '%1', 'h', 0.25)).toBe(true);
		// %2's side gets 25% → %1 gets 75%
		const rects = t.computeRects(161, 40);
		expect(rects.get('%1')?.width).toBeCloseTo(120, -1);
	});

	test('nested same-direction splits: outer divider is addressable', () => {
		// h[h[%1,%3], %2] — the exact shape setPaneSize cannot reach: every
		// pane's deepest h-ancestor is the inner split.
		const t = new PaneLayoutTree();
		t.setInitialPanes(['%1']);
		t.split('%1', 'h', '%2');
		t.split('%1', 'h', '%3');
		expect(t.setSplitRatio('%3', '%2', 'h', 0.75)).toBe(true);
		const rects = t.computeRects(161, 40);
		// Outer first side (containing %1+%3) gets ~75% of usable 160 = ~120.
		const leftSide = (rects.get('%1')?.width ?? 0) + (rects.get('%3')?.width ?? 0) + 1;
		expect(leftSide).toBeCloseTo(120, -1);
		// Inner split untouched: %1 and %3 still share their side evenly.
		expect(Math.abs((rects.get('%1')?.width ?? 0) - (rects.get('%3')?.width ?? 0))).toBeLessThanOrEqual(1);
	});

	test('2x2 grid: root ratio changes, column-internal splits untouched', () => {
		// h[v[%1,%3], v[%2,%4]]
		const t = new PaneLayoutTree();
		t.setInitialPanes(['%1']);
		t.split('%1', 'h', '%2');
		t.split('%1', 'v', '%3');
		t.split('%2', 'v', '%4');
		expect(t.setSplitRatio('%1', '%2', 'h', 0.25)).toBe(true);
		const rects = t.computeRects(161, 41);
		expect(rects.get('%1')?.width).toBeCloseTo(40, -1);
		expect(rects.get('%3')?.width).toBeCloseTo(40, -1);
		// Vertical splits keep their even share.
		expect(Math.abs((rects.get('%1')?.height ?? 0) - (rects.get('%3')?.height ?? 0))).toBeLessThanOrEqual(1);
	});

	test('direction mismatch is rejected without modifying the tree', () => {
		const t = twoPane(); // h split
		expect(t.setSplitRatio('%1', '%2', 'v', 0.25)).toBe(false);
		const rects = t.computeRects(161, 40);
		expect(rects.get('%1')?.width).toBeCloseTo(80, -1); // still ~50%
	});

	test('unknown pane is rejected', () => {
		const t = twoPane();
		expect(t.setSplitRatio('%1', '%9', 'h', 0.25)).toBe(false);
	});

	test('ratio is clamped to the valid range', () => {
		const t = twoPane();
		expect(t.setSplitRatio('%1', '%2', 'h', 0.01)).toBe(true);
		const rects = t.computeRects(161, 40);
		expect(rects.get('%1')?.width ?? 0).toBeGreaterThanOrEqual(16); // >= 10%
	});
});

describe('PaneLayoutTree.split duplicate guard', () => {
  test('splitting with an id already in the tree does not create a duplicate leaf', () => {
    const t = twoPane();
    // Simulate reconcile having already added %3 before the split RPC returns
    t.addUnknown('%3');
    t.split('%1', 'h', '%3');
    const ids = t.paneIds();
    expect(ids.filter((id) => id === '%3').length).toBe(1);
  });
});

/**
 * A leaf's id has to survive the trip to the client, and herdr's pane tokens
 * are base36 — `Number.parseInt('A')` is NaN, JSON turns that into null, and
 * the client read the pane back as `%0`. Numbers still travel as numbers so a
 * peer running an older frontend keeps rendering the panes it always could.
 */
describe('toTmuxLayout leaf ids', () => {
  test('a numeric pane travels as a number', () => {
    const layout = twoPane().toTmuxLayout(160, 40);
    expect(layout?.children?.map((c) => c.paneId)).toEqual([1, 2]);
  });

  test('a base36 pane travels as its whole %N string', () => {
    const t = new PaneLayoutTree();
    t.setInitialPanes(['%9']);
    t.split('%9', 'h', '%A');
    const layout = t.toTmuxLayout(160, 40);
    expect(layout?.children?.map((c) => c.paneId)).toEqual([9, '%A']);
    expect(paneIdFromLayout(layout?.children?.[1].paneId)).toBe('%A');
  });
});

/**
 * Zoom is metadata, never a structural collapse. `toTmuxLayout` must keep the
 * full split tree even while a pane is zoomed — that is what makes a zoomed
 * multi-pane session distinguishable from a genuine single-pane one on the
 * wire, so the client can still render every pane (mobile tab bar) and decide
 * how to present zoom itself. Regressing this reintroduces the "tab bar
 * disappears on reload" bug.
 */
describe('PaneLayoutTree zoom', () => {
  test('toTmuxLayout keeps the full tree while zoomed', () => {
    const t = twoPane();
    t.setZoom('%1');
    const layout = t.toTmuxLayout(160, 40);
    expect(layout?.type).not.toBe('leaf'); // still a split, not a lone leaf
    expect(layout?.children?.length).toBe(2);
  });

  test('zoomed getter reflects setZoom / toggleZoom', () => {
    const t = twoPane();
    expect(t.zoomed).toBeNull();
    t.setZoom('%2');
    expect(t.zoomed).toBe('%2');
    t.setZoom(null);
    expect(t.zoomed).toBeNull();
    t.toggleZoom('%1');
    expect(t.zoomed).toBe('%1');
    t.toggleZoom('%1'); // toggling the same pane clears it
    expect(t.zoomed).toBeNull();
  });

  test('setZoom is idempotent (unlike toggle)', () => {
    const t = twoPane();
    t.setZoom('%1');
    t.setZoom('%1');
    expect(t.zoomed).toBe('%1'); // still zoomed, not toggled off
  });

  test('computeRects: zoomed pane fills the client for PTY sizing', () => {
    const t = twoPane();
    t.setZoom('%1');
    const rects = t.computeRects(160, 40);
    // Only the zoomed pane, at full size — this drives its PTY resize.
    expect(rects.size).toBe(1);
    expect(rects.get('%1')).toEqual({ x: 0, y: 0, width: 160, height: 40 });
  });

  test('computeRects(ignoreZoom): full split geometry regardless of zoom', () => {
    const t = twoPane();
    t.setZoom('%1');
    const rects = t.computeRects(161, 40, { ignoreZoom: true });
    expect(rects.size).toBe(2);
    expect(rects.get('%1')?.width).toBeCloseTo(80, -1);
    expect(rects.get('%2')?.width).toBeCloseTo(80, -1);
  });

  test('removing the zoomed pane clears zoom', () => {
    const t = twoPane();
    t.setZoom('%2');
    t.remove('%2');
    expect(t.zoomed).toBeNull();
  });
});
