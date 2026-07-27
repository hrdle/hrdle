import type { ExtendedSessionResponse, PaneInfo } from "../../../shared/types";

/**
 * The panes the terminal is showing.
 *
 * `session.panes` spans every tab of the workspace — a pane in another tab is
 * still a running agent, and the list is where you reach it. The terminal
 * renders one tab, so anything describing what is on screen has to narrow back
 * down, or a workspace with a pane parked in a second tab stops looking like
 * the single-pane workspace it appears to be.
 *
 * Falls back to all panes when the session reports no active tab: an older
 * server, or a workspace herdr has not tagged, should behave as it always did.
 */
export function visiblePanes(
	session:
		| Pick<ExtendedSessionResponse, "panes" | "activeTabId">
		| null
		| undefined,
): PaneInfo[] {
	const panes = session?.panes;
	if (!panes) return [];
	const activeTabId = session?.activeTabId;
	if (!activeTabId) return panes;
	// A pane with no tabId predates the field; keeping it is the safer read.
	const inTab = panes.filter((p) => !p.tabId || p.tabId === activeTabId);
	return inTab.length > 0 ? inTab : panes;
}

/** The pane to describe a session by, when exactly one is on screen. */
export function soleVisiblePane(
	session:
		| Pick<ExtendedSessionResponse, "panes" | "activeTabId">
		| null
		| undefined,
): PaneInfo | undefined {
	const panes = visiblePanes(session);
	return panes.length === 1 ? panes[0] : undefined;
}
