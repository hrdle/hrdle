import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../services/api";
import { paneUrl } from "./pane-url";

/**
 * Claude Code draws its suggestion a moment after the turn ends, so the first
 * reads come soon after the pane goes quiet and the rest settle into a slower
 * re-read, which also follows a suggestion typed over or accepted in herdr.
 */
const FIRST_READS_MS = [0, 1500, 4000];
const REREAD_MS = 8000;

/**
 * The next prompt Claude Code suggests for this pane, while `active`. Cleared
 * the moment it stops being active, so a suggestion from the last turn is not
 * offered for the next one.
 */
export function usePaneSuggestion(
	sessionId: string,
	paneId: string,
	peerId: string | undefined,
	active: boolean,
) {
	const [suggestion, setSuggestion] = useState<string | null>(null);

	const read = useCallback(async () => {
		try {
			const res = await authFetch(paneUrl(sessionId, paneId, peerId, "suggestion"));
			if (!res.ok) return;
			const data = (await res.json()) as { suggestion: string | null };
			setSuggestion(data.suggestion ?? null);
		} catch {
			// The next read decides.
		}
	}, [sessionId, paneId, peerId]);

	useEffect(() => {
		if (!active) {
			setSuggestion(null);
			return;
		}
		const timers = FIRST_READS_MS.map((ms) => setTimeout(read, ms));
		const interval = setInterval(read, REREAD_MS);
		return () => {
			for (const timer of timers) clearTimeout(timer);
			clearInterval(interval);
		};
	}, [active, read]);

	return { suggestion, clear: () => setSuggestion(null) };
}
