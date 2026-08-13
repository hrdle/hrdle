/**
 * Terminal input/output filter utilities.
 *
 * These are extracted from Terminal.tsx so they can be unit-tested independently
 * of the React component and xterm.js runtime.
 */

// ESC character used in terminal escape sequences
const ESC = String.fromCharCode(0x1b);

/**
 * Filter mouse tracking escape sequences from terminal INPUT data.
 *
 * xterm.js may generate SGR-style (\x1b[<...M/m) and legacy (\x1b[M...)
 * mouse reports when it's in mouse tracking mode or when touch/scroll events
 * occur. These must be stripped before sending to the server: input is passed
 * through to the pane's raw PTY, so they would reach the shell as literal bytes.
 */
const SGR_MOUSE_RE = new RegExp(`${ESC}\\[<[\\d;]*[Mm]`, "g");
const LEGACY_MOUSE_RE = new RegExp(`${ESC}\\[M[\\s\\S]{3}`, "g");

export function filterMouseTrackingInput(data: string): string {
	return data
		.replace(SGR_MOUSE_RE, "") // SGR mouse reports
		.replace(LEGACY_MOUSE_RE, ""); // Legacy X10 mouse reports
}

const ARROW_KEYS = new Set([
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
]);

/**
 * The chords the app owns rather than the pane.
 *
 * This is the one place they are listed. xterm.js consumes a key it has a
 * binding for and calls `stopPropagation()` on it, so a shortcut that is not
 * named here never reaches the window listener that runs it — the pane gets
 * the control byte instead, and the shortcut silently does nothing (or, for
 * `Ctrl+D`, exits the shell). Whether xterm binds a given chord also depends
 * on the pane's mode, so "it works when I try it" is not evidence: measured on
 * herdr 0.8.0, `Ctrl+Shift+Arrow` reached the window from a Claude Code pane
 * and was swallowed by a plain zsh one.
 *
 * Deliberately NOT here, because the pane needs them more than the app does:
 * `Ctrl+D` (EOF), `Ctrl+W` (delete word) and `Ctrl+Arrow` (word motion). The
 * app's own versions of those live on the Shift'd chords below.
 *
 * `Ctrl+C` and `Ctrl+V` are not here either — they have their own actions,
 * because they need the default suppressed as well.
 */
export function isAppShortcut(e: {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	altKey?: boolean;
}): boolean {
	// Alt+Arrow — move the focus between panes. Alone among the app's chords it
	// carries no Ctrl, so it is checked before the modifier gate below.
	if (e.altKey && !e.ctrlKey && !e.metaKey) {
		return ARROW_KEYS.has(e.key);
	}

	if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
	const key = e.key.toLowerCase();

	if (e.shiftKey) {
		// Split, close a pane, resize, equalize, the dashboard, cache clear.
		return (
			key === "d" ||
			key === "e" ||
			key === "x" ||
			key === "b" ||
			key === "f5" ||
			key === "=" ||
			key === "+" ||
			ARROW_KEYS.has(e.key)
		);
	}

	// The session modal, font size, and switching session by number.
	return (
		key === "b" ||
		key === "=" ||
		key === "+" ||
		key === "-" ||
		/^[0-9]$/.test(key)
	);
}

/**
 * Determine whether a keyboard event should be intercepted by our custom
 * handler (returning false to xterm's attachCustomKeyEventHandler).
 *
 * Returns a string describing the action to take, or null if xterm should
 * handle the event normally.
 */
export type InterceptAction =
	| "shift-enter"
	| "paste"
	| "copy"
	| "app-shortcut"
	| null;

export function shouldInterceptKeyEvent(
	e: {
		type: string;
		key: string;
		ctrlKey: boolean;
		metaKey: boolean;
		shiftKey: boolean;
		altKey?: boolean;
	},
	hasSelection?: boolean,
): InterceptAction {
	if (e.type !== "keydown") return null;

	// Shift+Enter → send literal backslash + carriage return
	if (e.shiftKey && e.key === "Enter") {
		return "shift-enter";
	}

	if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
		const key = e.key.toLowerCase();
		// Ctrl/Cmd + C with selection → copy (prevent xterm from sending \x03 SIGINT)
		// Without selection → let xterm handle normally (sends SIGINT)
		if (key === "c" && hasSelection) {
			return "copy";
		}
		// Ctrl/Cmd + V → delegate to DesktopLayout's handlePaste (supports images)
		if (key === "v") {
			return "paste";
		}
	}

	// Keep xterm off it so it reaches the window listener that runs it. The
	// default is left alone here on purpose — that listener calls
	// preventDefault itself, and suppressing it twice would swallow the chords
	// it decides not to act on.
	if (isAppShortcut(e)) {
		return "app-shortcut";
	}

	return null;
}
