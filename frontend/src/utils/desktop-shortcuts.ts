export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export type DesktopShortcut =
	| { kind: "focus-pane"; key: ArrowKey }
	| { kind: "split"; direction: "horizontal" | "vertical" }
	| { kind: "close-pane" }
	| { kind: "copy" }
	| { kind: "paste" }
	| { kind: "font-size"; delta: number }
	| { kind: "font-size-reset" }
	| { kind: "toggle-session-modal" }
	| { kind: "toggle-dashboard" }
	| { kind: "resize-pane"; direction: "L" | "R" | "U" | "D"; amount: number }
	| { kind: "equalize-panes" }
	| { kind: "reload" }
	| { kind: "switch-session"; index: number };

interface KeyChord {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}

const ARROW_DIRECTION: Record<ArrowKey, "L" | "R" | "U" | "D"> = {
	ArrowLeft: "L",
	ArrowRight: "R",
	ArrowUp: "U",
	ArrowDown: "D",
};

function isArrow(key: string): key is ArrowKey {
	return key in ARROW_DIRECTION;
}

export const DEFAULT_FONT_SIZE = 14;

/**
 * The window-level shortcut a key chord names, or null when it is not one.
 * A chord only reaches the window listener if `isAppShortcut` lets it past
 * xterm, so a chord added here must be added there too (copy and paste are
 * the exceptions: xterm hands those over through `shouldInterceptKeyEvent`).
 */
export function matchDesktopShortcut(e: KeyChord): DesktopShortcut | null {
	// Alt+Arrow carries no Ctrl: Ctrl+Arrow is word motion in every shell.
	if (e.altKey && !e.ctrlKey && !e.metaKey && isArrow(e.key)) {
		return { kind: "focus-pane", key: e.key };
	}

	// Ctrl and Cmd are interchangeable, for Mac keyboards on Linux and back.
	if (!(e.ctrlKey || e.metaKey)) return null;
	const key = e.key.toLowerCase();

	if (e.shiftKey && key === "e") return { kind: "split", direction: "horizontal" };
	if (e.shiftKey && key === "d") return { kind: "split", direction: "vertical" };
	// Not Ctrl+Shift+W, which the browser keeps for closing its own window.
	if (e.shiftKey && key === "x") return { kind: "close-pane" };
	if (!e.shiftKey && key === "c") return { kind: "copy" };
	if (!e.shiftKey && key === "v") return { kind: "paste" };
	if (!e.shiftKey && (e.key === "=" || e.key === "+")) {
		return { kind: "font-size", delta: 2 };
	}
	if (!e.shiftKey && e.key === "-") return { kind: "font-size", delta: -2 };
	if (!e.shiftKey && e.key === "0") return { kind: "font-size-reset" };
	if (!e.shiftKey && key === "b") return { kind: "toggle-session-modal" };
	if (e.shiftKey && key === "b") return { kind: "toggle-dashboard" };
	if (e.shiftKey && !e.altKey && isArrow(e.key)) {
		const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
		return {
			kind: "resize-pane",
			direction: ARROW_DIRECTION[e.key],
			amount: horizontal ? 5 : 3,
		};
	}
	if (e.shiftKey && !e.altKey && (e.key === "+" || e.key === "=")) {
		return { kind: "equalize-panes" };
	}
	if (e.shiftKey && e.key === "F5") return { kind: "reload" };

	const num = Number.parseInt(e.key, 10);
	if (!e.shiftKey && num >= 1 && num <= 9) {
		return { kind: "switch-session", index: num - 1 };
	}
	return null;
}
