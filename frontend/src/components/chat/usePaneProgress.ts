import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../services/api";
import { paneUrl } from "./pane-url";

export interface PaneProgress {
	glyph: string;
	label: string;
	detail?: string;
}

/** The elapsed time on the line counts in seconds; this keeps it close. */
const REREAD_MS = 2000;

/**
 * The line Claude Code draws above its input box while a turn runs
 * (`✻ Waddling… (5s · ↓ 390 tokens)`), re-read while `active`. Cleared the
 * moment it stops being active, so a finished turn's last reading does not
 * linger as if it were still going.
 */
export function usePaneProgress(
	sessionId: string,
	paneId: string,
	peerId: string | undefined,
	active: boolean,
) {
	const [progress, setProgress] = useState<PaneProgress | null>(null);

	const read = useCallback(async () => {
		try {
			const res = await authFetch(paneUrl(sessionId, paneId, peerId, "progress"));
			if (!res.ok) return;
			const data = (await res.json()) as { progress: PaneProgress | null };
			setProgress(data.progress ?? null);
		} catch {
			// The next read decides.
		}
	}, [sessionId, paneId, peerId]);

	useEffect(() => {
		if (!active) {
			setProgress(null);
			return;
		}
		void read();
		const interval = setInterval(read, REREAD_MS);
		return () => clearInterval(interval);
	}, [active, read]);

	return progress;
}
