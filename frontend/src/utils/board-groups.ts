import type {
	ExtendedSessionResponse,
	IndicatorState,
	PaneInfo,
} from "../../../shared/types";

/**
 * The four questions a person has about a list of agents, in the order they
 * matter: which are waiting on me, which finished without my seeing it, which
 * are still going, and which have nothing to say.
 */
export const BOARD_GROUPS = ["needsYou", "unseen", "working", "idle"] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

function groupOf(
	state: IndicatorState | undefined,
	unseen: boolean | undefined,
): BoardGroup {
	if (state === "waiting_input") return "needsYou";
	if (state === "processing") return "working";
	return unseen ? "unseen" : "idle";
}

const RANK: Record<BoardGroup, number> = {
	needsYou: 0,
	working: 1,
	unseen: 2,
	idle: 3,
};

/**
 * One workspace goes in one group, decided by the pane that most needs a
 * person. A workspace with one pane waiting and one finished is waiting; one
 * with a pane still working and another finished unseen is working, because
 * opening it now would interrupt nothing and settle nothing.
 *
 * Panes of every tab count. The card's own indicator reads the tab on screen,
 * but a board is for finding the pane that is not on screen.
 */
export function boardGroupOf(session: ExtendedSessionResponse): BoardGroup {
	const agentPanes = (session.panes ?? []).filter((p) => p.agent);
	if (agentPanes.length === 0) {
		return groupOf(session.indicatorState, session.unseen);
	}
	let best: BoardGroup = "idle";
	for (const p of agentPanes) {
		const g = groupOf(p.indicatorState, p.unseen);
		if (RANK[g] < RANK[best]) best = g;
	}
	return best;
}

/**
 * The pane a row opens: the one that put the workspace in its group. Opening
 * it focuses it, and focus is what herdr reads as "seen".
 */
export function boardPaneOf(
	session: ExtendedSessionResponse,
): PaneInfo | undefined {
	const agentPanes = (session.panes ?? []).filter((p) => p.agent);
	const group = boardGroupOf(session);
	return (
		agentPanes.find((p) => groupOf(p.indicatorState, p.unseen) === group) ??
		agentPanes[0] ??
		session.panes?.[0]
	);
}

export type BoardSections = Record<BoardGroup, ExtendedSessionResponse[]>;

/** Sessions keep the order they arrived in within each group. */
export function groupSessionsForBoard(
	sessions: ExtendedSessionResponse[],
): BoardSections {
	const out: BoardSections = { needsYou: [], unseen: [], working: [], idle: [] };
	for (const s of sessions) out[boardGroupOf(s)].push(s);
	return out;
}
