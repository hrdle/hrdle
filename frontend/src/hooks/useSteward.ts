import { useCallback, useEffect, useState } from "react";
import type {
	StewardAskAnswer,
	StewardSessionLine,
	StewardThreadItem,
	StewardTurn,
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
	/** True while the steward is working on a turn. Someone who has just spoken
	 *  and sees nothing cannot tell "it is thinking" from "it never arrived". */
	thinking: boolean;
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
	const [thinking, setThinking] = useState(false);

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
			await refetch();
			// Waking is asynchronous, so the answer arrives on its own clock. Watch
			// for it rather than leaving the screen looking like nothing happened.
			setThinking(true);
			void watchForAnswer(refetch, setThinking);
		},
		[refetch],
	);

	return { thread, lines, isLoading, error, thinking, reply, refetch };
}

/**
 * Poll until the steward has answered, or long enough that it clearly will not.
 *
 * Polling rather than a socket because the mux connection belongs to the
 * terminal and this screen is not one; the window is short and only open while
 * someone is actually waiting for a reply.
 */
async function watchForAnswer(
	refetch: () => Promise<void>,
	setThinking: (value: boolean) => void,
): Promise<void> {
	const deadline = Date.now() + 120_000;
	try {
		// A moment for the wake-up to be delivered before deciding it is idle:
		// the observer is woken through a subprocess, so `idle` right after a
		// reply means "not yet", not "finished".
		await new Promise((r) => setTimeout(r, 1500));
		while (Date.now() < deadline) {
			const res = await authFetch(`${API_BASE}/api/steward/observer`);
			const body = res.ok ? ((await res.json()) as { status?: string }) : null;
			await refetch();
			if (body?.status && body.status !== "working") return;
			await new Promise((r) => setTimeout(r, 2000));
		}
	} catch {
		// The indicator is not worth an error message of its own.
	} finally {
		setThinking(false);
	}
}

/**
 * Whether this screen shows what the steward wrote.
 *
 * One state, not a setting per screen: the list and the session view switch
 * together, because "see it through the steward" is a single way of looking.
 *
 * localStorage rather than a server setting - the server's gate decides
 * whether the steward runs at all, and a second server-side switch would be
 * impossible to tell apart from it. Written only when someone toggles it, so
 * the default stays changeable.
 */
const VIEW_KEY = "hrdle-steward-view";

export function stewardViewEnabled(): boolean {
	return localStorage.getItem(VIEW_KEY) === "true";
}

export function useStewardView(): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(stewardViewEnabled);

	useEffect(() => {
		// Two screens read this, and a toggle in the dashboard has to reach the
		// list behind it.
		const sync = () => setOn(stewardViewEnabled());
		window.addEventListener("hrdle-steward-view", sync);
		return () => window.removeEventListener("hrdle-steward-view", sync);
	}, []);

	const set = useCallback((next: boolean) => {
		localStorage.setItem(VIEW_KEY, String(next));
		setOn(next);
		window.dispatchEvent(new Event("hrdle-steward-view"));
	}, []);

	return [on, set];
}

/** Turns for one session, asking the steward to write them when there are none. */
export function useStewardSession(sessionId: string | null, active: boolean) {
	const [turns, setTurns] = useState<StewardTurn[]>([]);
	const [waiting, setWaiting] = useState(false);

	useEffect(() => {
		if (!active || !sessionId) return;
		let alive = true;

		const load = async (): Promise<StewardTurn[]> => {
			const res = await authFetch(
				`${API_BASE}/api/steward/sessions/${encodeURIComponent(sessionId)}/turns`,
			);
			if (!res.ok) return [];
			return ((await res.json()) as { turns?: StewardTurn[] }).turns ?? [];
		};

		void (async () => {
			const first = await load();
			if (!alive) return;
			setTurns(first);
			if (first.length > 0) return;

			// Nothing written yet: ask, then watch for it rather than showing the
			// raw transcript, which would leave this session never summarised.
			setWaiting(true);
			try {
				await authFetch(
					`${API_BASE}/api/steward/sessions/${encodeURIComponent(sessionId)}/summarise`,
					{ method: "POST" },
				);
				const deadline = Date.now() + 120_000;
				while (alive && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 2500));
					const next = await load();
					if (!alive) return;
					if (next.length > 0) {
						setTurns(next);
						return;
					}
				}
			} finally {
				if (alive) setWaiting(false);
			}
		})();

		return () => {
			alive = false;
		};
	}, [sessionId, active]);

	return { turns, waiting };
}

/**
 * The steward's overview lines, keyed by workspace id.
 *
 * Empty unless the steward is on and this screen is set to show it, which is
 * what lets the list keep its own rendering untouched: an absent line is the
 * ordinary case, not a failure.
 */
export function useStewardLines(): Map<string, string> {
	const enabled = useStewardEnabled();
	const [view] = useStewardView();
	const [lines, setLines] = useState<Map<string, string>>(new Map());

	useEffect(() => {
		if (!enabled || !view) {
			setLines(new Map());
			return;
		}
		let alive = true;
		const load = async () => {
			try {
				const res = await authFetch(`${API_BASE}/api/steward`);
				if (!res.ok) return;
				const body = (await res.json()) as { lines?: StewardSessionLine[] };
				if (!alive) return;
				setLines(new Map((body.lines ?? []).map((l) => [l.sessionId, l.text])));
			} catch {
				// The list is fine without them.
			}
		};
		void load();
		// The list itself refreshes on a 5s push; matching that keeps a row and
		// its line from disagreeing for long.
		const timer = setInterval(load, 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [enabled, view]);

	return lines;
}
