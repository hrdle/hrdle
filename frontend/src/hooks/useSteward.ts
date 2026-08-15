import { useCallback, useEffect, useState } from "react";
import type {
	StewardAskAnswer,
	StewardSessionLine,
	StewardThreadItem,
} from "../../../shared/types";
import { authFetch } from "../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * Whether this server has a steward at all.
 *
 * Asked once per page rather than per mount: the answer is a server setting,
 * and a mode that appears and disappears while someone is looking at it is
 * worse than one that waits for a reload. `/enabled` answers whether or not
 * the steward is on, so a 404 here means a server too old to have any of it.
 */
let enabledCache: boolean | null = null;
let enabledInflight: Promise<boolean> | null = null;

function askEnabled(): Promise<boolean> {
	if (enabledCache !== null) return Promise.resolve(enabledCache);
	enabledInflight ??= authFetch(`${API_BASE}/api/steward/enabled`)
		.then(async (res) => {
			if (!res.ok) return false;
			const body = (await res.json()) as { enabled?: boolean };
			return body.enabled === true;
		})
		.catch(() => false)
		.then((value) => {
			enabledCache = value;
			enabledInflight = null;
			return value;
		});
	return enabledInflight;
}

export function useStewardEnabled(): boolean {
	const [enabled, setEnabled] = useState(enabledCache ?? false);
	useEffect(() => {
		let alive = true;
		void askEnabled().then((value) => {
			if (alive) setEnabled(value);
		});
		return () => {
			alive = false;
		};
	}, []);
	return enabled;
}

export interface UseStewardReturn {
	thread: StewardThreadItem[];
	lines: StewardSessionLine[];
	isLoading: boolean;
	error: string | null;
	/** Say something, or answer a question the steward asked. */
	reply: (input: { text?: string; askId?: string; answer?: StewardAskAnswer }) => Promise<void>;
	refetch: () => Promise<void>;
}

/**
 * The steward thread and the overview lines.
 *
 * Reads over REST and follows over the mux WebSocket, which the terminal
 * already holds open - `subscribe-steward` carries the thread, every session's
 * line and every session's turns on one subscription, because the overview
 * needs all of them at once.
 */
export function useSteward(enabled: boolean): UseStewardReturn {
	const [thread, setThread] = useState<StewardThreadItem[]>([]);
	const [lines, setLines] = useState<StewardSessionLine[]>([]);
	const [isLoading, setIsLoading] = useState(enabled);
	const [error, setError] = useState<string | null>(null);

	const refetch = useCallback(async () => {
		if (!enabled) return;
		try {
			const res = await authFetch(`${API_BASE}/api/steward`);
			if (!res.ok) throw new Error(`steward: ${res.status}`);
			const body = (await res.json()) as {
				thread: StewardThreadItem[];
				lines: StewardSessionLine[];
			};
			setThread(body.thread ?? []);
			setLines(body.lines ?? []);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsLoading(false);
		}
	}, [enabled]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	const reply = useCallback(
		async (input: { text?: string; askId?: string; answer?: StewardAskAnswer }) => {
			const res = await authFetch(`${API_BASE}/api/steward/thread/reply`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			if (!res.ok) {
				const detail = await res.text();
				throw new Error(detail || `reply: ${res.status}`);
			}
			// The server pushes the new items over the socket, but a reply is the
			// one moment someone is watching for their own words to appear.
			await refetch();
		},
		[refetch],
	);

	return { thread, lines, isLoading, error, reply, refetch };
}
