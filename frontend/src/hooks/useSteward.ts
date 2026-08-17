import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type {
	StewardAskAnswer,
	StewardSessionLine,
	StewardThreadItem,
	StewardTurn,
} from "../../../shared/types";
import {
	SAID_EVENT,
	overviewSayPending,
} from "../components/steward/StewardSessionComposer";
import {
	clearThinking,
	markThinking,
	useThinkingSince,
} from "../components/steward/thinking";
import { authFetch } from "../services/api";
import {
	getStewardSnapshot,
	seedStewardThread,
	seedStewardTurns,
	subscribeSteward,
	turnsKey,
} from "../services/steward-socket";

const API_BASE = import.meta.env.VITE_API_URL || "";

/** One frozen empty array, so a session with nothing written does not hand a
 *  new identity to every render. */
const EMPTY_TURNS: StewardTurn[] = [];

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

/**
 * The live store, while this screen wants it.
 *
 * `useSyncExternalStore` rather than an effect: the snapshot is module state
 * that can change between render and subscribe, and a missed frame here is a
 * message that never appears.
 */
function useStewardLive(enabled: boolean) {
	return useSyncExternalStore(
		useCallback(
			(onChange: () => void) => (enabled ? subscribeSteward(onChange) : () => {}),
			[enabled],
		),
		getStewardSnapshot,
		getStewardSnapshot,
	);
}

export interface UseStewardReturn {
	thread: StewardThreadItem[];
	lines: StewardSessionLine[];
	isLoading: boolean;
	error: string | null;
	/** True while the steward is working on a turn. Someone who has just spoken
	 *  and sees nothing cannot tell "it is thinking" from "it never arrived". */
	thinking: boolean;
	/** Say something, or answer a question the steward asked. `sessionId` is the
	 *  session the person was reading when they wrote it. */
	reply: (input: {
		text?: string;
		askId?: string;
		answer?: StewardAskAnswer;
		sessionId?: string;
	}) => Promise<void>;
	refetch: () => Promise<void>;
}

/**
 * The steward thread and the overview lines.
 *
 * Followed over `subscribe-steward`, which carries the thread, every session's
 * line and every session's turns on one subscription - the overview needs all
 * of them at once, and two devices open at the same time have to see each
 * other's messages.
 */
export function useSteward(enabled: boolean): UseStewardReturn {
	const live = useStewardLive(enabled);
	const [error, setError] = useState<string | null>(null);
	const thinking = useThinkingSince("") !== null;
	const thread = live.thread;
	const lines = live.lines;
	// The socket's first frame is the whole thread, so "loading" is "nothing
	// has arrived yet" rather than a request in flight.
	const isLoading = enabled && live.revision === 0;

	// The socket carries what changes; this seeds the first paint and answers
	// the moments a caller wants the state now rather than on the next frame.
	const refetch = useCallback(async () => {
		if (!enabled) return;
		try {
			const res = await authFetch(`${API_BASE}/api/steward`);
			if (!res.ok) throw new Error(`steward: ${res.status}`);
			const body = (await res.json()) as {
				thread?: StewardThreadItem[];
				lines?: StewardSessionLine[];
			};
			seedStewardThread(body.thread ?? [], body.lines ?? []);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [enabled]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	// Said from the overview, which then opens this screen: without the cue you
	// land on your own sentence with nothing to say it is being worked on, and
	// the answer appears a minute later out of nowhere.
	useEffect(() => {
		if (!enabled) return;
		const watch = () => {
			void refetch();
			void watchForAnswer("", refetch);
		};
		// Said a moment ago, from the screen that opened this one.
		if (overviewSayPending()) watch();
		const onSaid = (e: Event) => {
			if ((e as CustomEvent<{ sessionId?: string }>).detail?.sessionId) return;
			watch();
		};
		window.addEventListener(SAID_EVENT, onSaid);
		return () => window.removeEventListener(SAID_EVENT, onSaid);
	}, [enabled, refetch]);

	const reply = useCallback(
		async (input: {
			text?: string;
			askId?: string;
			answer?: StewardAskAnswer;
			sessionId?: string;
		}) => {
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
			void watchForAnswer(input.sessionId ?? "", refetch);
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
	key: string,
	refetch: () => Promise<void>,
): Promise<void> {
	const deadline = Date.now() + 120_000;
	markThinking(key);
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
		clearThinking(key);
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

/**
 * Turns for one session, asking the steward to write them when there are none,
 * and carrying what the person says back about this session.
 *
 * The steward is who this screen talks to. The pane's own input bar reaches the
 * agent and shows nothing here, which read as the message having gone nowhere.
 */
export function useStewardSession(
	sessionId: string | null,
	active: boolean,
	/** The pane whose history to read, when the workspace runs several agents.
	 *  Absent for a workspace with one, which keeps the workspace's own. */
	paneId?: string,
) {
	const live = useStewardLive(active && !!sessionId);
	const [waiting, setWaiting] = useState(false);
	const thinking = useThinkingSince(sessionId ?? "") !== null;
	const turns =
		(sessionId ? live.turns.get(turnsKey(sessionId, paneId)) : undefined) ?? EMPTY_TURNS;

	// The snapshot on subscribe carries the thread and the lines only, so the
	// first read of a session's turns is still REST; every later change arrives
	// as a push, including one made from another device.
	useEffect(() => {
		if (!active || !sessionId) return;
		let alive = true;
		// The pane travels as a query parameter: a `%` in a path is an escape,
		// and a pane id round-tripping through one is a bug nobody should have
		// to think about twice.
		const paneQuery = paneId ? `?pane=${encodeURIComponent(paneId)}` : "";

		const load = async (): Promise<StewardTurn[]> => {
			const res = await authFetch(
				`${API_BASE}/api/steward/sessions/${encodeURIComponent(sessionId)}/turns${paneQuery}`,
			);
			if (!res.ok) return [];
			const next = ((await res.json()) as { turns?: StewardTurn[] }).turns ?? [];
			if (alive) seedStewardTurns(sessionId, next, paneId);
			return next;
		};

		void (async () => {
			const first = await load();
			if (!alive || first.length > 0) return;

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
					if ((await load()).length > 0) return;
				}
			} finally {
				if (alive) setWaiting(false);
			}
		})();

		return () => {
			alive = false;
		};
	}, [sessionId, active, paneId]);

	// Saying something is the one moment worth not waiting a frame for, and the
	// composer is not always in this subtree - on a phone it is in the fixed
	// bottom bar - so the cue is an event rather than a callback.
	useEffect(() => {
		if (!active || !sessionId) return;
		const onSaid = (e: Event) => {
			if ((e as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId) return;
			void watchForAnswer(sessionId, async () => {});
		};
		window.addEventListener(SAID_EVENT, onSaid);
		return () => window.removeEventListener(SAID_EVENT, onSaid);
	}, [active, sessionId]);

	return { turns, waiting, thinking };
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
	const live = useStewardLive(enabled && view);

	return useMemo(
		() =>
			enabled && view
				? new Map(live.lines.map((l) => [l.sessionId, l.text]))
				: new Map<string, string>(),
		[enabled, view, live.lines],
	);
}
