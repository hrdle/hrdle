import type { PaneNode } from "../components/PaneContainer";

/** Find a pane by id anywhere in the tree. */
export function findPaneById(node: PaneNode, id: string): PaneNode | null {
	if (node.id === id) return node;
	if (node.type === "split") {
		for (const child of node.children) {
			const found = findPaneById(child, id);
			if (found) return found;
		}
	}
	return null;
}

/** First terminal (leaf) pane in the tree, in depth-first order. */
export function firstLeaf(node: PaneNode): PaneNode | null {
	if (node.type === "terminal") return node;
	if (node.type === "split") {
		for (const child of node.children) {
			const found = firstLeaf(child);
			if (found) return found;
		}
	}
	return null;
}

interface DisplayedRootOptions {
	/** The pane this client has focused. */
	activePane: string;
	/** The pane the server reports zoomed, if any. */
	zoomedPaneId: string | null;
	/** Whether this is the phone's layout. */
	isMobile: boolean;
}

/**
 * The subtree actually drawn, given what the server has zoomed and which pane
 * this client has focused.
 *
 * **A phone draws exactly one pane whether or not the zoom has landed.** It
 * gets the pane to the size of the screen by zooming, and the zoom is a request
 * over a socket that is dropped outright when the socket is not open - so
 * making the *rendering* wait for it turns a lost message into a broken screen
 * rather than a slow one. And broken it is: on a phone the session bar and the
 * InputBar belong to the pane that draws them, so a second pane on screen is a
 * second bar stacked on the first, which is what shipped in v0.3.130.
 *
 * Desktop and tablet draw the whole tree unless the server says a pane is
 * zoomed; splits are the point there.
 *
 * **There is no path back to a split on a phone**, including the one that
 * looks harmless: a pane id that is not in the tree. That happens for a render
 * or two whenever the tree is replaced - a session switch, a pane closed
 * elsewhere - and falling back to the whole tree there puts two of everything
 * on screen for exactly as long as it takes somebody to photograph it.
 */
export function displayedPaneRoot(
	root: PaneNode,
	{ activePane, zoomedPaneId, isMobile }: DisplayedRootOptions,
): PaneNode {
	if (isMobile) {
		return findPaneById(root, activePane) ?? firstLeaf(root) ?? root;
	}
	if (zoomedPaneId) {
		// A zoomed pane that no longer exists (it was closed) falls back to the
		// whole tree rather than to nothing.
		const pane = findPaneById(root, zoomedPaneId);
		if (pane) return pane;
	}
	return root;
}
