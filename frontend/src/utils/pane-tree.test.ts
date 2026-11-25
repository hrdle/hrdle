import { describe, expect, test } from "bun:test";
import type { TmuxLayoutNode } from "../../../shared/types";
import type { PaneNode } from "../components/PaneContainer";
import {
	extractPaneSizes,
	firstLeafId,
	getAllPaneIds,
	tmuxLayoutToPaneNode,
	updateAllSessionKeys,
	updateSessionKey,
} from "./pane-tree";

const leaf = (
	paneId: number | string,
	x: number,
	y: number,
	width: number,
	height: number,
): TmuxLayoutNode => ({ type: "leaf", paneId, x, y, width, height });

// A 2x2 grid: the left column starts at the same corner as the root, which is
// what made position-derived split ids collide.
const grid: TmuxLayoutNode = {
	type: "horizontal",
	x: 0,
	y: 0,
	width: 161,
	height: 41,
	children: [
		{
			type: "vertical",
			x: 0,
			y: 0,
			width: 120,
			height: 41,
			children: [leaf(1, 0, 0, 120, 20), leaf(2, 0, 21, 120, 20)],
		},
		leaf("%A", 121, 0, 40, 41),
	],
};

describe("tmuxLayoutToPaneNode", () => {
	const tree = tmuxLayoutToPaneNode(grid, "local:w1");

	test("gives nested splits distinct ids even when they share a corner", () => {
		expect(tree.id).toBe("split-r");
		expect(tree.type === "split" && tree.children[0].id).toBe("split-r.0");
	});

	test("derives ratios from the children's extent along the split", () => {
		expect(tree.type === "split" && tree.ratio).toEqual([75, 25]);
		const left = tree.type === "split" ? tree.children[0] : null;
		expect(left?.type === "split" && left.direction).toBe("vertical");
		expect(left?.type === "split" && left.ratio).toEqual([50, 50]);
	});

	test("names leaves by their pane id, numeric or base36", () => {
		expect(getAllPaneIds(tree)).toEqual(["%1", "%2", "%A"]);
	});
});

test("extractPaneSizes reads each leaf's cols and rows", () => {
	const sizes = extractPaneSizes(grid);
	expect(sizes.get("%1")).toEqual({ cols: 120, rows: 20 });
	expect(sizes.get("%A")).toEqual({ cols: 40, rows: 41 });
	expect(sizes.size).toBe(3);
});

describe("session keys", () => {
	const tree: PaneNode = tmuxLayoutToPaneNode(grid, "local:w1");

	test("updateSessionKey changes only the named pane", () => {
		const next = updateSessionKey(tree, "%2", "peer:w9");
		const keys = new Map<string, string | null>();
		const walk = (n: PaneNode) => {
			if (n.type === "terminal") keys.set(n.id, n.sessionKey);
			else n.children.forEach(walk);
		};
		walk(next);
		expect(Object.fromEntries(keys)).toEqual({
			"%1": "local:w1",
			"%2": "peer:w9",
			"%A": "local:w1",
		});
	});

	test("updateAllSessionKeys changes every pane", () => {
		const next = updateAllSessionKeys(tree, "peer:w9");
		const walk = (n: PaneNode): (string | null)[] =>
			n.type === "terminal" ? [n.sessionKey] : n.children.flatMap(walk);
		expect(walk(next)).toEqual(["peer:w9", "peer:w9", "peer:w9"]);
	});
});

test("firstLeafId walks depth-first", () => {
	const tree = tmuxLayoutToPaneNode(grid, "local:w1");
	expect(firstLeafId(tree)).toBe("%1");
	expect(tree.type === "split" && firstLeafId(tree.children[1])).toBe("%A");
});
