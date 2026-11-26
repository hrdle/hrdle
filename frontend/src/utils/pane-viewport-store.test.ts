import { describe, expect, test } from "bun:test";
import type { PaneViewport } from "../../../shared/types";
import { PaneViewportStore } from "./pane-viewport-store";

function frame(offset: number, historySize = 100, tag = "f"): PaneViewport {
	return {
		paneId: "%1",
		cols: 4,
		rows: 3,
		lines: [`${tag}${offset}a`, `${tag}${offset}b`, `${tag}${offset}c`],
		cursor: { x: 0, y: 0, visible: true },
		modes: { altScreen: false },
		historySize,
		offset,
		atTail: offset === 0,
	};
}

function record(store: PaneViewportStore, paneId = "%1") {
	const seen: Array<{ viewport: PaneViewport; isPseudo?: boolean }> = [];
	const stop = store.listen(paneId, (viewport, isPseudo) => {
		seen.push({ viewport, isPseudo });
	});
	return { seen, stop };
}

/** Back at the live edge, holding frames for offsets 0 and 3. */
function holdingThree(store: PaneViewportStore, historySize = 100): PaneViewport {
	store.receive("%1", frame(0, historySize));
	store.scrollBy("%1", -3);
	const atThree = frame(3, historySize);
	store.receive("%1", atThree);
	store.scrollToLive("%1");
	return atThree;
}

describe("receive", () => {
	test("hands a frame to every listener of its pane and no other", () => {
		const store = new PaneViewportStore();
		const a = record(store, "%1");
		const b = record(store, "%1");
		const other = record(store, "%2");
		const f = frame(0);
		store.receive("%1", f);
		expect(a.seen).toEqual([{ viewport: f, isPseudo: false }]);
		expect(b.seen).toEqual([{ viewport: f, isPseudo: false }]);
		expect(other.seen).toEqual([]);
	});

	test("takes the server's offset as the position when none was asked for", () => {
		const store = new PaneViewportStore();
		store.receive("%1", frame(7));
		expect(store.offset("%1")).toBe(7);
		expect(store.historySize("%1")).toBe(100);
	});

	test("a reply for an offset already scrolled past is not painted", () => {
		const store = new PaneViewportStore();
		store.receive("%1", frame(0));
		const { seen } = record(store);
		seen.length = 0;
		store.scrollBy("%1", -10);
		seen.length = 0;
		store.receive("%1", frame(5));
		expect(seen).toEqual([]);
		expect(store.offset("%1")).toBe(10);
	});

	test("a pane nobody listens to keeps its frame for whoever listens next", () => {
		const store = new PaneViewportStore();
		const f = frame(0);
		store.receive("%1", f);
		const { seen } = record(store);
		expect(seen).toEqual([{ viewport: f, isPseudo: undefined }]);
	});
});

describe("listen", () => {
	test("stops delivering once unsubscribed", () => {
		const store = new PaneViewportStore();
		const { seen, stop } = record(store);
		stop();
		store.receive("%1", frame(0));
		expect(seen).toEqual([]);
	});

	test("lists every pane listened to, even after it stopped", () => {
		const store = new PaneViewportStore();
		record(store, "%1").stop();
		record(store, "%2");
		expect(store.listenedPaneIds()).toEqual(["%1", "%2"]);
	});
});

describe("scrollBy", () => {
	test("moves into history and returns the offset to ask for", () => {
		const store = new PaneViewportStore();
		store.receive("%1", frame(0));
		expect(store.scrollBy("%1", -3)).toBe(3);
		expect(store.offset("%1")).toBe(3);
		expect(store.scrollBy("%1", 2)).toBe(1);
	});

	test("stops at the top of the history and at the live edge", () => {
		const store = new PaneViewportStore();
		store.receive("%1", frame(0, 10));
		expect(store.scrollBy("%1", -50)).toBe(10);
		expect(store.scrollBy("%1", -1)).toBeNull();
		expect(store.scrollBy("%1", 50)).toBe(0);
		expect(store.scrollBy("%1", 1)).toBeNull();
	});

	test("cannot move a pane that has had no frame", () => {
		const store = new PaneViewportStore();
		expect(store.scrollBy("%1", -3)).toBeNull();
	});

	test("paints a stitched frame while the server's answer is on its way", () => {
		const store = new PaneViewportStore();
		store.receive("%1", frame(0));
		const { seen } = record(store);
		seen.length = 0;
		store.scrollBy("%1", -1);
		expect(seen).toHaveLength(1);
		expect(seen[0].isPseudo).toBe(true);
		expect(seen[0].viewport.offset).toBe(1);
		expect(seen[0].viewport.lines[1]).toBe("f0a");
	});

	test("repaints a frame already held for that offset", () => {
		const store = new PaneViewportStore();
		const atThree = holdingThree(store);
		const { seen } = record(store);
		seen.length = 0;
		store.scrollBy("%1", -3);
		expect(seen).toEqual([{ viewport: atThree, isPseudo: false }]);
	});

	test("a held frame from a different history length is not reused", () => {
		const store = new PaneViewportStore();
		holdingThree(store, 100);
		store.receive("%1", frame(0, 120));
		const { seen } = record(store);
		seen.length = 0;
		store.scrollBy("%1", -3);
		expect(seen[0].isPseudo).toBe(true);
	});

	test("keeps at most twenty frames per pane, dropping the oldest", () => {
		const store = new PaneViewportStore();
		for (let offset = 0; offset <= 20; offset++) store.receive("%1", frame(offset));
		const { seen } = record(store);
		seen.length = 0;
		store.scrollBy("%1", -1);
		expect(seen).toEqual([{ viewport: frame(1), isPseudo: false }]);
		seen.length = 0;
		store.scrollToLive("%1");
		expect(seen[0].isPseudo).toBe(true);
	});
});

describe("scrollToLive", () => {
	test("returns to the live edge and says whether it moved", () => {
		const store = new PaneViewportStore();
		store.receive("%1", frame(0));
		expect(store.scrollToLive("%1")).toBe(false);
		store.scrollBy("%1", -5);
		expect(store.scrollToLive("%1")).toBe(true);
		expect(store.offset("%1")).toBe(0);
	});

	test("repaints the live frame it already holds", () => {
		const store = new PaneViewportStore();
		const live = frame(0);
		store.receive("%1", live);
		store.scrollBy("%1", -5);
		const { seen } = record(store);
		seen.length = 0;
		store.scrollToLive("%1");
		expect(seen).toEqual([{ viewport: live, isPseudo: false }]);
	});
});

describe("forgetting", () => {
	test("dropFrames keeps the position but stitches instead of repainting", () => {
		const store = new PaneViewportStore();
		holdingThree(store);
		store.dropFrames();
		const { seen } = record(store);
		seen.length = 0;
		store.scrollBy("%1", -3);
		expect(seen[0].isPseudo).toBe(true);
	});

	test("forgetPositions clears what was shown but keeps the listeners", () => {
		const store = new PaneViewportStore();
		const { seen } = record(store);
		store.receive("%1", frame(0));
		store.scrollBy("%1", -4);
		store.forgetPositions();
		expect(store.offset("%1")).toBe(0);
		expect(store.historySize("%1")).toBe(0);
		seen.length = 0;
		const next = frame(9, 100, "g");
		store.receive("%1", next);
		expect(seen).toEqual([{ viewport: next, isPseudo: false }]);
	});

	test("clear forgets positions and frames", () => {
		const store = new PaneViewportStore();
		store.receive("%1", frame(0));
		store.clear();
		expect(store.historySize("%1")).toBe(0);
		expect(store.scrollBy("%1", -1)).toBeNull();
	});
});
