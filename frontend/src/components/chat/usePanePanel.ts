import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../../services/api";
import { paneUrl } from "./pane-url";

export type PanelKey = "up" | "down" | "left" | "right" | "enter" | "esc";

/** Reads after a slash command goes in: the panel is drawn a moment later. */
const LOOK_MS = [600, 1500, 3000];
/** While a panel is up it is re-read, since its numbers and cursor move. */
const REREAD_MS = 2000;
/** A key's effect is on screen by then. */
const AFTER_KEY_MS = 300;

/**
 * A panel Claude Code drew over its input box (`/usage`, `/model`, `/config`)
 * and the keys that move through it. It is looked for only after a slash
 * command is sent, and followed only while it is there: reading the screen
 * every few seconds for a panel that is almost never open would be a pane
 * read spent on nothing.
 */
export function usePanePanel(sessionId: string, paneId: string, peerId: string | undefined) {
	const [lines, setLines] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

	const read = useCallback(async () => {
		try {
			const res = await authFetch(paneUrl(sessionId, paneId, peerId, "panel"));
			if (!res.ok) return;
			const data = (await res.json()) as { panel: { lines: string[] } | null };
			setLines(data.panel?.lines ?? null);
		} catch {
			// The next read decides.
		}
	}, [sessionId, paneId, peerId]);

	const clearTimers = useCallback(() => {
		for (const t of timers.current) clearTimeout(t);
		timers.current = [];
	}, []);

	const watch = useCallback(() => {
		clearTimers();
		timers.current = LOOK_MS.map((ms) => setTimeout(read, ms));
	}, [read, clearTimers]);

	const open = lines !== null;
	useEffect(() => {
		if (!open) return;
		const interval = setInterval(read, REREAD_MS);
		return () => clearInterval(interval);
	}, [open, read]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a different pane starts with no panel
	useEffect(() => {
		setLines(null);
		setError(null);
		return clearTimers;
	}, [sessionId, paneId, peerId]);

	const press = async (key: PanelKey) => {
		setBusy(true);
		setError(null);
		try {
			const res = await authFetch(paneUrl(sessionId, paneId, peerId, "keys"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ keys: [key] }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error || `status ${res.status}`);
			}
			await new Promise((r) => setTimeout(r, AFTER_KEY_MS));
			await read();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return { lines, error, busy, watch, press };
}
