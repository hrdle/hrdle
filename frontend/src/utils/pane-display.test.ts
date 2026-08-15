import { describe, expect, test } from "bun:test";
import type { PaneNode } from "../components/PaneContainer";
import { displayedPaneRoot, findPaneById } from "./pane-display";

const leaf = (id: string): PaneNode => ({
	type: "terminal",
	sessionKey: "local:w1",
	id,
});

const split: PaneNode = {
	type: "split",
	direction: "horizontal",
	children: [leaf("%1"), leaf("%2")],
	ratio: [50, 50],
	id: "split-r",
};

describe("displayedPaneRoot", () => {
	/**
	 * The regression this file exists for. v0.3.130 narrowed the phone's tree
	 * only once the server confirmed a zoom, and `zoom-pane` is dropped without
	 * error when the socket is not open - so a phone that missed the reply drew
	 * both panes, each with its own session bar and its own InputBar.
	 */
	test("a phone draws one pane even when nothing is zoomed", () => {
		const shown = displayedPaneRoot(split, {
			activePane: "%2",
			zoomedPaneId: null,
			isMobile: true,
		});
		expect(shown).toEqual(leaf("%2"));
	});

	test("a phone follows the pane it has focused, not the one the server zoomed", () => {
		const shown = displayedPaneRoot(split, {
			activePane: "%1",
			zoomedPaneId: "%2",
			isMobile: true,
		});
		expect(shown).toEqual(leaf("%1"));
	});

	/**
	 * The id goes stale for a render or two every time the tree is replaced - a
	 * session switch, a pane closed on another client. Falling back to the whole
	 * tree there would put the split back on screen, bars and all.
	 */
	test("a phone still draws one pane when its pane id is not in the tree", () => {
		const shown = displayedPaneRoot(split, {
			activePane: "%9",
			zoomedPaneId: null,
			isMobile: true,
		});
		expect(shown).toEqual(leaf("%1"));
	});

	test("a phone draws one pane whatever the tree looks like", () => {
		const nested: PaneNode = {
			type: "split",
			direction: "vertical",
			children: [split, leaf("%3")],
			ratio: [60, 40],
			id: "split-outer",
		};
		for (const activePane of ["%1", "%2", "%3", "nope"]) {
			const shown = displayedPaneRoot(nested, {
				activePane,
				zoomedPaneId: null,
				isMobile: true,
			});
			expect(shown.type).toBe("terminal");
		}
	});

	test("a desktop draws the whole tree until the server zooms", () => {
		expect(
			displayedPaneRoot(split, {
				activePane: "%1",
				zoomedPaneId: null,
				isMobile: false,
			}),
		).toBe(split);
		expect(
			displayedPaneRoot(split, {
				activePane: "%1",
				zoomedPaneId: "%2",
				isMobile: false,
			}),
		).toEqual(leaf("%2"));
	});

	test("a single pane is drawn as itself on every layout", () => {
		const only = leaf("%1");
		for (const isMobile of [true, false]) {
			expect(
				displayedPaneRoot(only, {
					activePane: "%1",
					zoomedPaneId: null,
					isMobile,
				}),
			).toBe(only);
		}
	});
});

describe("findPaneById", () => {
	test("finds a leaf nested in a split", () => {
		expect(findPaneById(split, "%2")).toEqual(leaf("%2"));
	});

	test("finds the split itself", () => {
		expect(findPaneById(split, "split-r")).toBe(split);
	});

	test("answers null for an id that is not in the tree", () => {
		expect(findPaneById(split, "%9")).toBeNull();
	});
});
