import { describe, expect, test } from "bun:test";
import type {
	ExtendedSessionResponse,
	IndicatorState,
	PaneInfo,
} from "../../../../shared/types";
import {
	boardGroupOf,
	boardPaneOf,
	groupSessionsForBoard,
} from "../board-groups";

function pane(
	paneId: string,
	indicatorState: IndicatorState | undefined,
	extra: Partial<PaneInfo> = {},
): PaneInfo {
	return { paneId, isActive: false, agent: "claude", indicatorState, ...extra };
}

function session(
	id: string,
	fields: Partial<ExtendedSessionResponse>,
): ExtendedSessionResponse {
	return {
		id,
		name: id,
		createdAt: "",
		lastAccessedAt: "",
		state: "idle",
		...fields,
	} as ExtendedSessionResponse;
}

describe("boardGroupOf", () => {
	test("a waiting pane puts the workspace under needs-you", () => {
		const s = session("a", { panes: [pane("%1", "waiting_input")] });
		expect(boardGroupOf(s)).toBe("needsYou");
	});

	test("finished and not looked at is its own group, apart from idle", () => {
		const unseen = session("a", {
			panes: [pane("%1", "completed", { unseen: true })],
		});
		const seen = session("b", { panes: [pane("%1", "completed")] });
		expect(boardGroupOf(unseen)).toBe("unseen");
		expect(boardGroupOf(seen)).toBe("idle");
	});

	test("the pane that most needs a person decides", () => {
		const s = session("a", {
			panes: [
				pane("%1", "completed", { unseen: true }),
				pane("%2", "processing"),
				pane("%3", "waiting_input"),
			],
		});
		expect(boardGroupOf(s)).toBe("needsYou");
	});

	test("still working outranks finished-unseen in the same workspace", () => {
		const s = session("a", {
			panes: [pane("%1", "completed", { unseen: true }), pane("%2", "processing")],
		});
		expect(boardGroupOf(s)).toBe("working");
	});

	test("a shell pane beside an agent does not count", () => {
		const s = session("a", {
			panes: [
				pane("%1", "completed"),
				{ paneId: "%2", isActive: true, indicatorState: "processing" },
			],
		});
		expect(boardGroupOf(s)).toBe("idle");
	});

	test("without pane detail the session's own fields are used", () => {
		expect(boardGroupOf(session("a", { indicatorState: "processing" }))).toBe(
			"working",
		);
		expect(
			boardGroupOf(session("b", { indicatorState: "completed", unseen: true })),
		).toBe("unseen");
		expect(boardGroupOf(session("c", {}))).toBe("idle");
	});
});

describe("boardPaneOf", () => {
	test("is the pane that put the workspace in its group", () => {
		const s = session("a", {
			panes: [pane("%1", "completed"), pane("%2", "completed", { unseen: true })],
		});
		expect(boardPaneOf(s)?.paneId).toBe("%2");
	});

	test("falls back to the first pane when there is no agent", () => {
		const s = session("a", { panes: [{ paneId: "%7", isActive: true }] });
		expect(boardPaneOf(s)?.paneId).toBe("%7");
		expect(boardPaneOf(session("b", {}))).toBeUndefined();
	});
});

describe("groupSessionsForBoard", () => {
	test("every session lands in exactly one group, in arrival order", () => {
		const sessions = [
			session("idle1", { panes: [pane("%1", "completed")] }),
			session("work1", { panes: [pane("%1", "processing")] }),
			session("wait1", { panes: [pane("%1", "waiting_input")] }),
			session("done1", { panes: [pane("%1", "completed", { unseen: true })] }),
			session("work2", { panes: [pane("%1", "processing")] }),
		];
		const g = groupSessionsForBoard(sessions);
		expect(g.needsYou.map((s) => s.id)).toEqual(["wait1"]);
		expect(g.unseen.map((s) => s.id)).toEqual(["done1"]);
		expect(g.working.map((s) => s.id)).toEqual(["work1", "work2"]);
		expect(g.idle.map((s) => s.id)).toEqual(["idle1"]);
	});
});
