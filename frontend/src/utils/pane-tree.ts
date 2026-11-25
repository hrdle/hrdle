import { paneIdFromLayout, type TmuxLayoutNode } from "../../../shared/types";
import { type PaneNode } from "../components/PaneContainer";
import type { TerminalRef } from "../components/Terminal";

// First terminal (leaf) pane id under a node, in depth-first order.
export function firstLeafId(node: PaneNode): string | null {
	if (node.type === "terminal") return node.id;
	if (node.type === "split") {
		for (const child of node.children) {
			const id = firstLeafId(child);
			if (id) return id;
		}
	}
	return null;
}

// Compute the session's total window size by summing pane sizes from the
// layout tree, following the wire layout's tmux-convention geometry:
// horizontal splits → sum cols + 1-cell borders, vertical → sum rows + borders.
// When useProposed=true, uses proposeDimensions() (what fits the container) instead of
// actual xterm size. This is needed in control mode where xterm size is set by the
// server's layout, not by FitAddon.
export function computeTotalSizeFromTree(
	root: PaneNode,
	terminalRefs: React.RefObject<Map<string, TerminalRef | null>>,
	useProposed = false,
): { cols: number; rows: number } | null {
	if (root.type === "terminal") {
		const ref = terminalRefs.current?.get(root.id);
		const size = useProposed
			? (ref?.getProposedSize?.() ?? ref?.getSize?.())
			: ref?.getSize?.();
		return size ?? null;
	}

	if (root.type === "split") {
		const childSizes = root.children.map((c) =>
			computeTotalSizeFromTree(c, terminalRefs, useProposed),
		);
		if (childSizes.some((s) => s === null)) return null;
		const sizes = childSizes as { cols: number; rows: number }[];

		if (root.direction === "horizontal") {
			// Panes side by side: total cols = sum + borders
			return {
				cols: sizes.reduce((sum, s) => sum + s.cols, 0) + (sizes.length - 1),
				rows: Math.max(...sizes.map((s) => s.rows)),
			};
		}
		// Panes stacked: total rows = sum + borders
		return {
			cols: Math.max(...sizes.map((s) => s.cols)),
			rows: sizes.reduce((sum, s) => sum + s.rows, 0) + (sizes.length - 1),
		};
	}

	return null;
}

// Per-pane render sizes to report as per-client demands. Sourced from each
// pane's proposed dimensions (what fits its container) — NOT the layout the
// server sent back — so demands can't lag or feed back into the server's
// sizing. Pass the zoom-aware root (the zoomed subtree when zoomed) so a zoomed
// pane reports its full-container size and hidden panes report nothing.
export function collectPaneDemands(
	root: PaneNode,
	terminalRefs: React.RefObject<Map<string, TerminalRef | null>>,
): Record<string, { cols: number; rows: number }> {
	const out: Record<string, { cols: number; rows: number }> = {};
	const walk = (n: PaneNode): void => {
		if (n.type === "terminal") {
			const ref = terminalRefs.current?.get(n.id);
			const size = ref?.getProposedSize?.() ?? ref?.getSize?.();
			if (size && size.cols > 0 && size.rows > 0) {
				out[n.id] = { cols: size.cols, rows: size.rows };
			}
			return;
		}
		if (n.type === "split") n.children.forEach(walk);
	};
	walk(root);
	return out;
}

// Get all pane IDs in order (leaf nodes only)
export function getAllPaneIds(node: PaneNode): string[] {
	if (node.type === "split") {
		return node.children.flatMap(getAllPaneIds);
	}
	// terminal, sessions, dashboard, empty are all leaf nodes
	return [node.id];
}

// Boundary-style divider drag. Moving the divider between children[i] and
// children[i+1] of `splitId` must move ONLY that boundary on screen: the two
// panes touching it absorb the delta, every other pane keeps its absolute
// size. Inside each adjacent child, same-direction splits
// along the touching edge renormalize their ratios to hold the interior
// boundaries still; cross-direction splits pass the change through to all
// children (each of their rows/columns touches the dragged boundary).
// Returns the original root unchanged when any resulting ratio would leave
// [10, 90] — the drag hard-stops at the limit instead of crushing a pane.
export function applyBoundaryDrag(
	root: PaneNode,
	splitId: string,
	newRatio: number[],
	dividerIndex: number,
): PaneNode {
	let valid = true;

	// `node`'s extent along `dir` changes oldExtent→newExtent (any consistent
	// unit); only the pane touching the dragged boundary — via `edge` — absorbs
	// the difference.
	const renormalize = (
		node: PaneNode,
		dir: "horizontal" | "vertical",
		edge: "start" | "end",
		oldExtent: number,
		newExtent: number,
	): PaneNode => {
		if (node.type !== "split" || oldExtent <= 0 || newExtent <= 0) return node;
		if (node.direction !== dir) {
			return {
				...node,
				children: node.children.map((c) =>
					renormalize(c, dir, edge, oldExtent, newExtent),
				),
			};
		}
		const abs = node.ratio.map((r) => (r / 100) * oldExtent);
		const idx = edge === "end" ? abs.length - 1 : 0;
		const absorbedOld = abs[idx] ?? 0;
		const absorbedNew = absorbedOld + (newExtent - oldExtent);
		abs[idx] = absorbedNew;
		const ratio = abs.map((w) => (w / newExtent) * 100);
		for (const r of ratio) {
			if (r < 10 || r > 90) valid = false;
		}
		return {
			...node,
			ratio,
			children: node.children.map((c, i) =>
				i === idx ? renormalize(c, dir, edge, absorbedOld, absorbedNew) : c,
			),
		};
	};

	const walk = (node: PaneNode): PaneNode => {
		if (node.type !== "split") return node;
		if (node.id !== splitId) {
			return { ...node, children: node.children.map(walk) };
		}
		const i = dividerIndex;
		const oldA = node.ratio[i];
		const oldB = node.ratio[i + 1];
		const newA = newRatio[i];
		const newB = newRatio[i + 1];
		if (
			oldA === undefined ||
			oldB === undefined ||
			newA === undefined ||
			newB === undefined
		) {
			return node;
		}
		const children = node.children.map((c, ci) => {
			if (ci === i) return renormalize(c, node.direction, "end", oldA, newA);
			if (ci === i + 1)
				return renormalize(c, node.direction, "start", oldB, newB);
			return c;
		});
		return { ...node, ratio: newRatio, children };
	};

	const next = walk(root);
	return valid ? next : root;
}

// Update one pane's session key in the tree
export function updateSessionKey(
	root: PaneNode,
	paneId: string,
	sessionKey: string,
): PaneNode {
	if (root.id === paneId && root.type === "terminal") {
		return { ...root, sessionKey };
	}
	if (root.type === "split") {
		return {
			...root,
			children: root.children.map((c) => updateSessionKey(c, paneId, sessionKey)),
		};
	}
	return root;
}

// Update ALL terminal panes' session key (used for control mode session switching)
export function updateAllSessionKeys(root: PaneNode, sessionKey: string): PaneNode {
	if (root.type === "terminal") {
		return { ...root, sessionKey };
	}
	if (root.type === "split") {
		return {
			...root,
			children: root.children.map((c) => updateAllSessionKeys(c, sessionKey)),
		};
	}
	return root;
}

// Convert TmuxLayoutNode to PaneNode with session IDs.
// Split ids derive from the node's PATH in the tree, not its x/y position:
// a nested split starting at the same corner as its parent (e.g. the left
// column of a 2x2, or the inner-left split of 4 columns) would collide under
// position-based ids, and ratio updates addressed by id would then hit the
// ancestor instead of the dragged split.
export function tmuxLayoutToPaneNode(
	node: TmuxLayoutNode,
	sessionKey: string,
	path = "r",
): PaneNode {
	if (node.type === "leaf") {
		return {
			type: "terminal",
			sessionKey,
			id: paneIdFromLayout(node.paneId),
		};
	}

	const children = (node.children || []).map((c, i) =>
		tmuxLayoutToPaneNode(c, sessionKey, `${path}.${i}`),
	);
	const isHorizontal = node.type === "horizontal";
	const totalSize = (node.children || []).reduce(
		(sum, c) => sum + (isHorizontal ? c.width : c.height),
		0,
	);
	const ratio = (node.children || []).map((c) => {
		const size = isHorizontal ? c.width : c.height;
		return totalSize > 0
			? (size / totalSize) * 100
			: 100 / (node.children || []).length;
	});

	return {
		type: "split",
		direction: isHorizontal ? "horizontal" : "vertical",
		children,
		ratio,
		id: `split-${path}`,
	};
}

// Extract per-pane {cols, rows} from a TmuxLayoutNode tree.
// TmuxLayoutNode width/height = pane cols/rows.
export function extractPaneSizes(
	node: TmuxLayoutNode,
): Map<string, { cols: number; rows: number }> {
	const sizes = new Map<string, { cols: number; rows: number }>();
	function walk(n: TmuxLayoutNode) {
		if (n.type === "leaf" && n.paneId !== undefined) {
			sizes.set(paneIdFromLayout(n.paneId), { cols: n.width, rows: n.height });
		}
		if (n.children) {
			n.children.forEach(walk);
		}
	}
	walk(node);
	return sizes;
}
