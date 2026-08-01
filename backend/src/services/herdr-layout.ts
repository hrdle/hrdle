/**
 * CC Hub-owned pane layout for herdr sessions.
 *
 * herdr's workspace grid cannot be resized headlessly (it stays at the
 * default client size when no interactive client is attached), so in herdr
 * mode CC Hub owns the split geometry itself: a binary split tree with
 * ratios, rendered to tmux-convention rects (siblings separated by one
 * cell, children partition the parent). The frontend keeps consuming
 * `TmuxLayoutNode` unchanged.
 */

import type { HerdrLayoutNode } from './herdr-client';
import type { TmuxLayoutNode } from '../../../shared/types';

export interface LeafNode {
  type: 'leaf';
  paneId: string; // tmux-style "%N"
}

export interface SplitNode {
  type: 'split';
  // 'h' = children side-by-side (tmux 'horizontal'), 'v' = stacked
  dir: 'h' | 'v';
  ratio: number; // share of the first child, 0.1..0.9
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

/**
 * Convert a herdr `layout.export` tree into a CC Hub `LayoutNode`. `mapPaneId`
 * maps a herdr pane id (`wK:pN`) to a tmux-style `%N`, returning null when the
 * id is unmappable. Returns null if *any* node fails to convert, so the caller
 * can fall back to a flat chain rather than render a partial/corrupt tree.
 *
 * herdr `right`/`down` split directions map to CC Hub `h`/`v`; `first`/`second`
 * children map to `a`/`b`; the ratio is clamped into the tree's valid range.
 */
export function herdrLayoutToNode(
  node: HerdrLayoutNode,
  mapPaneId: (herdrPaneId: string) => string | null,
): LayoutNode | null {
  if (node.type === 'pane') {
    const paneId = mapPaneId(node.pane_id);
    return paneId ? { type: 'leaf', paneId } : null;
  }
  const a = herdrLayoutToNode(node.first, mapPaneId);
  const b = herdrLayoutToNode(node.second, mapPaneId);
  if (!a || !b) return null;
  const rawRatio = Number.isFinite(node.ratio) ? node.ratio : 0.5;
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, rawRatio));
  return { type: 'split', dir: node.direction === 'right' ? 'h' : 'v', ratio, a, b };
}

export class PaneLayoutTree {
  private root: LayoutNode | null = null;
  private zoomedPane: string | null = null;

  /** Hydrate directly from a prebuilt tree (e.g. herdr's exported layout). */
  setInitialTree(root: LayoutNode): void {
    this.root = root;
    this.zoomedPane = null;
  }

  /** Initialize from an existing pane list (chained side-by-side, even). */
  setInitialPanes(paneIds: string[]): void {
    this.root = null;
    this.zoomedPane = null;
    for (const id of paneIds) {
      if (!this.root) {
        this.root = { type: 'leaf', paneId: id };
      } else {
        this.root = { type: 'split', dir: 'h', ratio: 0.5, a: this.root, b: { type: 'leaf', paneId: id } };
      }
    }
  }

  paneIds(): string[] {
    const out: string[] = [];
    const walk = (n: LayoutNode | null): void => {
      if (!n) return;
      if (n.type === 'leaf') {
        out.push(n.paneId);
      } else {
        walk(n.a);
        walk(n.b);
      }
    };
    walk(this.root);
    return out;
  }

  has(paneId: string): boolean {
    return this.paneIds().includes(paneId);
  }

  get zoomed(): string | null {
    return this.zoomedPane;
  }

  /** Split `target` in two; `newPane` becomes the second child. */
  split(target: string, dir: 'h' | 'v', newPane: string): void {
    // A pane.created event can race the split RPC response: reconcile may
    // have already grafted the new pane at the root via addUnknown(). Remove
    // it first so the pane ends up as a single leaf at its intended position.
    if (this.has(newPane)) {
      this.remove(newPane);
    }
    const replace = (n: LayoutNode): LayoutNode => {
      if (n.type === 'leaf') {
        if (n.paneId !== target) return n;
        return { type: 'split', dir, ratio: 0.5, a: n, b: { type: 'leaf', paneId: newPane } };
      }
      return { ...n, a: replace(n.a), b: replace(n.b) };
    };
    if (this.root) this.root = replace(this.root);
    this.zoomedPane = null;
  }

  /** Append a pane we discovered but didn't create (external split etc.). */
  addUnknown(paneId: string): void {
    if (this.has(paneId)) return;
    if (!this.root) {
      this.root = { type: 'leaf', paneId };
    } else {
      this.root = { type: 'split', dir: 'h', ratio: 0.5, a: this.root, b: { type: 'leaf', paneId } };
    }
  }

  /** Remove a pane; its sibling takes the parent's slot. */
  remove(paneId: string): void {
    const prune = (n: LayoutNode): LayoutNode | null => {
      if (n.type === 'leaf') {
        return n.paneId === paneId ? null : n;
      }
      const a = prune(n.a);
      const b = prune(n.b);
      if (a && b) return { ...n, a, b };
      return a ?? b;
    };
    if (this.root) this.root = prune(this.root);
    if (this.zoomedPane === paneId) this.zoomedPane = null;
  }

  toggleZoom(paneId: string): void {
    this.zoomedPane = this.zoomedPane === paneId ? null : paneId;
  }

  /** Explicitly zoom `paneId` (or clear zoom with `null`). Idempotent. */
  setZoom(paneId: string | null): void {
    this.zoomedPane = paneId;
  }

  /**
   * Nudge the split ratio of the nearest ancestor split matching the
   * direction. L/R adjust an 'h' split, U/D adjust a 'v' split; amount is
   * in cells relative to the total client size.
   */
  adjust(paneId: string, direction: 'L' | 'R' | 'U' | 'D', amountCells: number, totalCols: number, totalRows: number): void {
    const wantDir: 'h' | 'v' = direction === 'L' || direction === 'R' ? 'h' : 'v';
    const total = wantDir === 'h' ? totalCols : totalRows;
    if (total <= 0) return;
    const delta = (amountCells / total) * (direction === 'L' || direction === 'U' ? -1 : 1);

    // Find the deepest matching-direction split that contains the pane.
    let found: SplitNode | null = null;
    let foundInFirst = false;
    const walk = (n: LayoutNode): boolean => {
      if (n.type === 'leaf') return n.paneId === paneId;
      const inA = walk(n.a);
      const inB = inA ? false : walk(n.b);
      if ((inA || inB) && n.dir === wantDir && !found) {
        found = n;
        foundInFirst = inA;
      }
      return inA || inB;
    };
    if (this.root) walk(this.root);
    if (found) {
      const node = found as SplitNode;
      // Growing the pane means growing whichever child it sits in.
      const signed = foundInFirst ? delta : -delta;
      node.ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, node.ratio + signed));
    }
  }

  /**
   * Set an absolute target size for one pane by adjusting the ratio of its
   * deepest same-direction ancestor split (per dimension). The pane's extent
   * equals its branch extent at that split (no same-direction split lies
   * below it on the path), so the ratio maps directly.
   */
  setPaneSize(paneId: string, cols: number, rows: number, totalCols: number, totalRows: number): void {
    this.setPaneExtent(paneId, 'h', cols, totalCols, totalRows);
    this.setPaneExtent(paneId, 'v', rows, totalCols, totalRows);
  }

  private setPaneExtent(
    paneId: string,
    dir: 'h' | 'v',
    desired: number,
    totalCols: number,
    totalRows: number,
  ): void {
    if (!this.root) return;
    let found: { node: SplitNode; extent: number; inFirst: boolean } | null = null;
    const walk = (n: LayoutNode, rect: PaneRect): boolean => {
      if (n.type === 'leaf') return n.paneId === paneId;
      const usable = (n.dir === 'h' ? rect.width : rect.height) - 1;
      const a = Math.max(1, Math.round(usable * n.ratio));
      const b = Math.max(1, usable - a);
      const rectA: PaneRect =
        n.dir === 'h'
          ? { ...rect, width: a }
          : { ...rect, height: a };
      const rectB: PaneRect =
        n.dir === 'h'
          ? { x: rect.x + a + 1, y: rect.y, width: b, height: rect.height }
          : { x: rect.x, y: rect.y + a + 1, width: rect.width, height: b };
      const inA = walk(n.a, rectA);
      const inB = inA ? false : walk(n.b, rectB);
      if ((inA || inB) && n.dir === dir) {
        // Deeper matches were already recorded (post-order); keep the first
        // (deepest) one only.
        if (!found) {
          found = { node: n, extent: usable, inFirst: inA };
        }
      }
      return inA || inB;
    };
    walk(this.root, { x: 0, y: 0, width: totalCols, height: totalRows });
    if (!found || (found as { extent: number }).extent <= 0) return;
    const f = found as { node: SplitNode; extent: number; inFirst: boolean };
    const share = desired / f.extent;
    const ratio = f.inFirst ? share : 1 - share;
    f.node.ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  }

  /**
   * Set the ratio of the lowest common ancestor split of two panes — the one
   * split whose divider separates paneA's subtree from paneB's, i.e. exactly
   * the divider the user dragged. setPaneSize cannot express this: it reaches
   * a pane's *deepest* same-direction ancestor, so the outer divider of
   * nested same-direction splits (h[h[A,B],C]) is unaddressable per-pane.
   * `ratio` is paneA's side's share. Returns false (no-op) when the panes
   * don't meet at a split of the expected direction.
   */
  setSplitRatio(paneA: string, paneB: string, dir: 'h' | 'v', ratio: number): boolean {
    if (!this.root || !Number.isFinite(ratio)) return false;
    const contains = (n: LayoutNode, id: string): boolean => {
      if (n.type === 'leaf') return n.paneId === id;
      return contains(n.a, id) || contains(n.b, id);
    };
    let target: SplitNode | null = null;
    let aInFirst = true;
    const walk = (n: LayoutNode): void => {
      if (n.type !== 'split') return;
      const firstHasA = contains(n.a, paneA);
      const firstHasB = contains(n.a, paneB);
      if (firstHasA && firstHasB) {
        walk(n.a);
        return;
      }
      if (!firstHasA && !firstHasB) {
        walk(n.b);
        return;
      }
      const secondHasA = contains(n.b, paneA);
      const secondHasB = contains(n.b, paneB);
      if ((firstHasA && secondHasB) || (firstHasB && secondHasA)) {
        target = n;
        aInFirst = firstHasA;
      }
    };
    walk(this.root);
    if (!target) return false;
    const split = target as SplitNode;
    if (split.dir !== dir) return false;
    const share = aInFirst ? ratio : 1 - ratio;
    split.ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, share));
    return true;
  }

  /** Reset every split of the given orientation to an even ratio. */
  equalize(direction: 'horizontal' | 'vertical'): void {
    const dir: 'h' | 'v' = direction === 'horizontal' ? 'h' : 'v';
    const walk = (n: LayoutNode): void => {
      if (n.type !== 'split') return;
      if (n.dir === dir) n.ratio = 0.5;
      walk(n.a);
      walk(n.b);
    };
    if (this.root) walk(this.root);
  }

  /**
   * Compute integer cell rects for every pane at the given client size,
   * tmux convention: children partition the parent with a 1-cell separator.
   * A zoomed pane occupies the full client area — unless `ignoreZoom` is set,
   * in which case the full split geometry is returned regardless of zoom
   * (used to render the wire layout tree, which always carries every pane).
   */
  computeRects(cols: number, rows: number, opts?: { ignoreZoom?: boolean }): Map<string, PaneRect> {
    const rects = new Map<string, PaneRect>();
    if (!opts?.ignoreZoom && this.zoomedPane && this.has(this.zoomedPane)) {
      rects.set(this.zoomedPane, { x: 0, y: 0, width: cols, height: rows });
      return rects;
    }
    const assign = (n: LayoutNode, rect: PaneRect): void => {
      if (n.type === 'leaf') {
        rects.set(n.paneId, rect);
        return;
      }
      if (n.dir === 'h') {
        const usable = rect.width - 1; // 1-col separator
        const wa = Math.max(1, Math.round(usable * n.ratio));
        const wb = Math.max(1, usable - wa);
        assign(n.a, { x: rect.x, y: rect.y, width: wa, height: rect.height });
        assign(n.b, { x: rect.x + wa + 1, y: rect.y, width: wb, height: rect.height });
      } else {
        const usable = rect.height - 1; // 1-row separator
        const ha = Math.max(1, Math.round(usable * n.ratio));
        const hb = Math.max(1, usable - ha);
        assign(n.a, { x: rect.x, y: rect.y, width: rect.width, height: ha });
        assign(n.b, { x: rect.x, y: rect.y + ha + 1, width: rect.width, height: hb });
      }
    };
    if (this.root) assign(this.root, { x: 0, y: 0, width: cols, height: rows });
    return rects;
  }

  /**
   * Render the tree as a TmuxLayoutNode for the frontend.
   *
   * Always the FULL split tree — a zoomed pane is NOT collapsed to a single
   * leaf here. Zoom travels separately (see `zoomed` / the layout message's
   * `zoomedPaneId`) so the client keeps the whole pane list and decides how to
   * present zoom itself. Collapsing here is what made a zoomed multi-pane
   * session indistinguishable from a genuine single-pane one on reconnect.
   */
  toTmuxLayout(cols: number, rows: number): TmuxLayoutNode | null {
    if (!this.root) return null;
    const rects = this.computeRects(cols, rows, { ignoreZoom: true });
    const convert = (n: LayoutNode, rect: PaneRect): TmuxLayoutNode => {
      if (n.type === 'leaf') {
        const r = rects.get(n.paneId) ?? rect;
        return {
          type: 'leaf',
          width: r.width,
          height: r.height,
          x: r.x,
          y: r.y,
          paneId: paneWireId(n.paneId),
        };
      }
      const childRect = (child: LayoutNode): PaneRect => boundingRect(child, rects) ?? rect;
      return {
        type: n.dir === 'h' ? 'horizontal' : 'vertical',
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
        children: [convert(n.a, childRect(n.a)), convert(n.b, childRect(n.b))],
      };
    };
    return convert(this.root, { x: 0, y: 0, width: cols, height: rows });
  }
}

/**
 * The leaf id as it travels on the wire.
 *
 * herdr pane tokens are base36 (`p1`..`p9`, `pA`, ...), so a pane past the
 * ninth has no number to carry and goes as the whole `%N` string instead —
 * `Number.parseInt('A')` is NaN, which JSON turns into null and the client
 * read as pane `%0`. A numeric token still goes as a number so an older
 * client on the other end of a peer connection, which only knows how to build
 * `%${paneId}`, keeps rendering the panes it always could.
 */
function paneWireId(tmuxPaneId: string): number | string {
  const token = tmuxPaneId.slice(1);
  return /^\d+$/.test(token) ? Number.parseInt(token, 10) : tmuxPaneId;
}

function boundingRect(n: LayoutNode, rects: Map<string, PaneRect>): PaneRect | null {
  if (n.type === 'leaf') return rects.get(n.paneId) ?? null;
  const a = boundingRect(n.a, rects);
  const b = boundingRect(n.b, rects);
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
