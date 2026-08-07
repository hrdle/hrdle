import { useCallback, useEffect, useState } from "react";
import type {
	PeerClientView,
	PeerCreateInput,
	PeerUpdateInput,
} from "../../../shared/types";
import { authFetch, isTransientNetworkError } from "../services/api";
import { reconnectPeerWatchersNow } from "./usePeerSessionsWatcher";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface UsePeersReturn {
	peers: PeerClientView[];
	isLoading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	addPeer: (input: PeerCreateInput) => Promise<PeerClientView>;
	updatePeer: (id: string, input: PeerUpdateInput) => Promise<PeerClientView>;
	deletePeer: (id: string) => Promise<void>;
	verifyPeer: (id: string) => Promise<{ status: string; latencyMs?: number; message?: string }>;
	reorderPeers: (orderedIds: string[]) => Promise<void>;
}

// Module-level cache shared by every component
let cachedPeers: PeerClientView[] | null = null;
let lastError: string | null = null;
/**
 * Whether the last `/api/peers` poll reached the server at all. `null` until
 * the first attempt settles.
 *
 * This poll is what the reachability signal is read from rather than a probe of
 * its own: it already runs every 5s for as long as the app is mounted, and it
 * is the *first* thing that fails when this device leaves the tailnet - the
 * session list has no fetch of its own to fail, it waits on a WebSocket that
 * simply never opens, which is why an unreachable server used to show as an
 * empty list rather than as anything being wrong.
 */
let lastReachable: boolean | null = null;
const listeners = new Set<() => void>();

// usePeers is called from several components at once, but the polling timer is
// kept as a single module-level one (reference counted). An interval per instance
// would multiply the 5s /api/peers polling by N (#336)
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<void> | null = null;

function notifyListeners() {
	for (const l of listeners) l();
}

function setReachable(reachable: boolean) {
	const wasUnreachable = lastReachable === false;
	lastReachable = reachable;
	// Coming back is worth acting on immediately. The session watchers back off
	// up to a minute between attempts, so without this the list stays empty for
	// most of a minute after the VPN is switched back on - which reads exactly
	// like the failure the user was told to fix.
	if (reachable && wasUnreachable) reconnectPeerWatchersNow();
}

async function fetchPeers(): Promise<PeerClientView[]> {
	const res = await authFetch(`${API_BASE}/api/peers`);
	if (!res.ok) throw new Error(`Failed to load peers: HTTP ${res.status}`);
	const data = (await res.json()) as { peers: PeerClientView[] };
	return data.peers;
}

// Concurrent requests are coalesced into one fetch
function refreshShared(): Promise<void> {
	if (refreshInFlight) return refreshInFlight;
	refreshInFlight = (async () => {
		try {
			cachedPeers = await fetchPeers();
			lastError = null;
			setReachable(true);
		} catch (err) {
			lastError = err instanceof Error ? err.message : "Failed to load peers";
			// An HTTP status - even 500 - means the server answered, so only a
			// transport failure counts as unreachable.
			setReachable(!isTransientNetworkError(err));
		} finally {
			refreshInFlight = null;
			notifyListeners();
		}
	})();
	return refreshInFlight;
}

function subscribePeers(listener: () => void): () => void {
	listeners.add(listener);
	if (!pollTimer) {
		// Periodic refresh to keep peer status current; runs only while there are subscribers
		pollTimer = setInterval(() => {
			void refreshShared();
		}, 5000);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	};
}

export function usePeers(): UsePeersReturn {
	const [peers, setPeers] = useState<PeerClientView[]>(() => cachedPeers ?? []);
	const [isLoading, setIsLoading] = useState(() => cachedPeers === null);
	const [error, setError] = useState<string | null>(() => lastError);

	useEffect(() => {
		const listener = () => {
			setPeers(cachedPeers ?? []);
			setError(lastError);
			setIsLoading(false);
		};
		const unsubscribe = subscribePeers(listener);
		// Initial load: a cached value settles immediately and the background poll refreshes it
		if (cachedPeers === null) {
			void refreshShared();
		} else {
			listener();
		}
		return unsubscribe;
	}, []);

	const refresh = useCallback(async () => {
		await refreshShared();
	}, []);

	const addPeer = useCallback(async (input: PeerCreateInput): Promise<PeerClientView> => {
		const res = await authFetch(`${API_BASE}/api/peers`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			throw new Error(err.error ?? `HTTP ${res.status}`);
		}
		const data = (await res.json()) as { peer: PeerClientView };
		await refresh();
		return data.peer;
	}, [refresh]);

	const updatePeerFn = useCallback(async (id: string, input: PeerUpdateInput): Promise<PeerClientView> => {
		const res = await authFetch(`${API_BASE}/api/peers/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			throw new Error(err.error ?? `HTTP ${res.status}`);
		}
		const data = (await res.json()) as { peer: PeerClientView };
		await refresh();
		return data.peer;
	}, [refresh]);

	const deletePeerFn = useCallback(async (id: string): Promise<void> => {
		const res = await authFetch(`${API_BASE}/api/peers/${id}`, { method: "DELETE" });
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			throw new Error(err.error ?? `HTTP ${res.status}`);
		}
		await refresh();
	}, [refresh]);

	const verifyPeerFn = useCallback(async (id: string) => {
		const res = await authFetch(`${API_BASE}/api/peers/${id}/verify`, { method: "POST" });
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			throw new Error(err.error ?? `HTTP ${res.status}`);
		}
		const result = (await res.json()) as { status: string; latencyMs?: number; message?: string };
		// verify updates the registry, so refetch the peers as well
		await refresh();
		return result;
	}, [refresh]);

	const reorderPeers = useCallback(async (orderedIds: string[]): Promise<void> => {
		const res = await authFetch(`${API_BASE}/api/peers/order`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ order: orderedIds }),
		});
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			throw new Error(err.error ?? `HTTP ${res.status}`);
		}
		await refresh();
	}, [refresh]);

	return {
		peers,
		isLoading,
		error,
		refresh,
		addPeer,
		updatePeer: updatePeerFn,
		deletePeer: deletePeerFn,
		verifyPeer: verifyPeerFn,
		reorderPeers,
	};
}

/**
 * Whether the server answered the last poll. `null` while the first attempt is
 * still in flight, so a caller can tell "not known yet" from "not reachable"
 * and avoid flashing a failure notice during startup.
 *
 * Shares the poll and the cache with `usePeers`, so subscribing costs nothing.
 */
export function useServerReachable(): boolean | null {
	// Not named setReachable: that is the module-level writer above, and one of
	// the two shadowing the other in this file is a trap.
	const [reachable, setValue] = useState<boolean | null>(() => lastReachable);

	useEffect(() => {
		const listener = () => setValue(lastReachable);
		const unsubscribe = subscribePeers(listener);
		if (cachedPeers === null && lastReachable === null) {
			void refreshShared();
		} else {
			listener();
		}
		return unsubscribe;
	}, []);

	return reachable;
}
