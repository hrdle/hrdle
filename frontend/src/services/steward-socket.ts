/**
 * What the steward writes, live.
 *
 * The server has broadcast `steward-*` over `/ws/mux` since the store existed;
 * nothing subscribed, so every screen read over REST and only when something
 * made it. Two devices open at once therefore never saw each other's messages
 * - the phone's reply was on the tablet only after the tablet did something of
 * its own.
 *
 * Its own connection rather than the terminal's: the terminal's follows the
 * selected session and lives inside the layout, and these screens are neither.
 * Same shape as `usePeerSessionsWatcher`, for the same reason.
 */

import type {
	MuxServerMessage,
	StewardSessionLine,
	StewardThreadItem,
	StewardTurn,
} from "../../../shared/types";
import { noteServerVersion } from "../services/build-version";
import { storageKey } from "../utils/app-storage";
import { appendWsToken } from "./peer-ws";

export interface StewardSnapshot {
	thread: StewardThreadItem[];
	lines: StewardSessionLine[];
	turns: ReadonlyMap<string, StewardTurn[]>;
	/** Bumped on every change, so a reader can depend on "something moved". */
	revision: number;
}

const state: {
	thread: StewardThreadItem[];
	lines: StewardSessionLine[];
	turns: Map<string, StewardTurn[]>;
	revision: number;
} = { thread: [], lines: [], turns: new Map(), revision: 0 };

const listeners = new Set<() => void>();
let snapshot: StewardSnapshot = { ...state, turns: state.turns };

let ws: WebSocket | null = null;
let retryTimer: number | null = null;
let pingTimer: number | null = null;
let retryAttempt = 0;
let subscribers = 0;
/** Whether the socket has delivered a snapshot; see `seedStewardThread`. */
let liveSnapshot = false;

const RETRY_INITIAL_MS = 3_000;
const RETRY_MAX_MS = 30_000;
// The backend's zombie cutoff is 60s.
const PING_INTERVAL_MS = 25_000;

function publish() {
	state.revision += 1;
	snapshot = {
		thread: state.thread,
		lines: state.lines,
		turns: state.turns,
		revision: state.revision,
	};
	for (const l of listeners) l();
}

/** An entry can be re-sent: answering an ask rewrites the item it lives on. */
function upsertThread(item: StewardThreadItem) {
	const at = state.thread.findIndex((i) => i.id === item.id);
	state.thread = at === -1 ? [...state.thread, item] : state.thread.map((i, n) => (n === at ? item : i));
}

function apply(msg: MuxServerMessage) {
	// Rides on a message that already arrives every five seconds.
	if (msg.type === "sessions-updated") return noteServerVersion(msg.version);

	switch (msg.type) {
		case "steward-snapshot":
			state.thread = msg.thread;
			state.lines = msg.lines;
			liveSnapshot = true;
			break;
		case "steward-thread":
			upsertThread(msg.item);
			break;
		case "steward-line": {
			const at = state.lines.findIndex((l) => l.sessionId === msg.line.sessionId);
			state.lines =
				at === -1 ? [...state.lines, msg.line] : state.lines.map((l, n) => (n === at ? msg.line : l));
			break;
		}
		case "steward-turns":
			state.turns = new Map(state.turns).set(turnsKey(msg.sessionId, msg.paneId), msg.turns);
			break;
		case "steward-session-removed": {
			const turns = new Map(state.turns);
			// Its panes' histories go with it: they are keyed by the workspace
			// with the pane appended, so deleting the bare id leaves them behind
			// to be shown for a workspace that no longer exists.
			for (const key of [...turns.keys()]) {
				if (key === msg.sessionId || key.startsWith(`${msg.sessionId}:`)) turns.delete(key);
			}
			state.turns = turns;
			state.lines = state.lines.filter((l) => l.sessionId !== msg.sessionId);
			break;
		}
		default:
			return;
	}
	publish();
}

function wsUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const base = import.meta.env.VITE_WS_URL || `${protocol}//${window.location.host}`;
	return appendWsToken(`${base}/ws/mux`, localStorage.getItem(storageKey("token")));
}

function open() {
	if (ws || subscribers === 0) return;
	let socket: WebSocket;
	try {
		socket = new WebSocket(wsUrl());
	} catch {
		scheduleRetry();
		return;
	}
	ws = socket;

	socket.onopen = () => {
		retryAttempt = 0;
		socket.send(JSON.stringify({ type: "subscribe-steward" }));
		pingTimer = window.setInterval(() => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: "ping", sessionId: "" }));
			}
		}, PING_INTERVAL_MS);
	};

	socket.onmessage = (event) => {
		try {
			apply(JSON.parse(event.data as string) as MuxServerMessage);
		} catch {
			// A frame this build does not know is not worth a console line.
		}
	};

	const done = () => {
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		if (ws === socket) ws = null;
		scheduleRetry();
	};
	socket.onclose = done;
	socket.onerror = done;
}

function scheduleRetry() {
	if (retryTimer !== null || subscribers === 0) return;
	const delay = Math.min(RETRY_INITIAL_MS * 2 ** retryAttempt, RETRY_MAX_MS);
	retryAttempt += 1;
	retryTimer = window.setTimeout(() => {
		retryTimer = null;
		open();
	}, delay);
}

function close() {
	if (retryTimer !== null) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
	if (pingTimer !== null) {
		clearInterval(pingTimer);
		pingTimer = null;
	}
	ws?.close();
	ws = null;
	retryAttempt = 0;
	// The guard covers one subscription. With nobody listening the next screen
	// starts again from REST, which is what a blocked socket has to fall back
	// on - and a live snapshot arms it again the moment one arrives.
	liveSnapshot = false;
}

export function subscribeSteward(onChange: () => void): () => void {
	listeners.add(onChange);
	subscribers += 1;
	open();
	return () => {
		listeners.delete(onChange);
		subscribers -= 1;
		if (subscribers === 0) close();
	};
}

export function getStewardSnapshot(): StewardSnapshot {
	return snapshot;
}

/**
 * The thread and lines as REST answered them.
 *
 * The socket is what keeps two devices in step, but the first paint must not
 * depend on it: a blocked WebSocket would otherwise leave the screen loading
 * forever, and the test harness stubs REST only.
 */
export function seedStewardThread(
	thread: StewardThreadItem[],
	lines: StewardSessionLine[],
): void {
	// REST seeds the first paint, and a screen opened later starts its fetch
	// after the socket has been delivering for a while - so this can arrive
	// behind live items and, replacing outright, drop them. What the socket has
	// sent is never older than what a fetch answers, so once it has spoken this
	// has nothing to add.
	if (liveSnapshot) return;
	state.thread = thread;
	state.lines = lines;
	publish();
}

/**
 * Which history a set of turns belongs to.
 *
 * A workspace running several agents keeps one per pane - two agents in one
 * workspace are two pieces of work, and a single history of both reads as one
 * conversation that keeps changing the subject. One running a single agent
 * names no pane and keeps the workspace's own key, which is what every
 * workspace used before the split.
 */
export function turnsKey(sessionId: string, paneId?: string): string {
	return paneId ? `${sessionId}:${paneId}` : sessionId;
}

/** Turns fetched over REST, folded in so a later push lands on top of them. */
export function seedStewardTurns(
	sessionId: string,
	turns: StewardTurn[],
	paneId?: string,
): void {
	state.turns = new Map(state.turns).set(turnsKey(sessionId, paneId), turns);
	publish();
}
