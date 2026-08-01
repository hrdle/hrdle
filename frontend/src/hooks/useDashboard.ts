import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardResponse } from "../../../shared/types";
import { authFetch, isTransientNetworkError } from "../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface UseDashboardReturn {
	data: DashboardResponse | null;
	isLoading: boolean;
	error: string | null;
	refetch: () => Promise<void>;
}

/**
 * Last payload, kept outside React.
 *
 * The dashboard panel is unmounted while closed, so component state does not
 * survive an open/close — every open used to start from `null`, render the
 * loading line and block on a round trip. Holding the payload here means a
 * reopen paints the numbers you were last shown and the refresh lands behind
 * it, which is what "instant" actually consists of.
 */
let cachedData: DashboardResponse | null = null;
/** Shared so two mounted consumers (panel + mobile overlay) issue one request. */
let inflight: Promise<DashboardResponse | null> | null = null;

/** How long after a stale-flagged payload to ask again for the refreshed one. */
const STALE_REFETCH_MS = 1500;

function fetchOnce(): Promise<DashboardResponse | null> {
	inflight ??= authFetch(`${API_BASE}/api/dashboard`)
		.then(async (response) => {
			if (!response.ok) throw new Error("Failed to fetch dashboard data");
			const result = (await response.json()) as DashboardResponse;
			cachedData = result;
			return result;
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

export function useDashboard(
	refreshInterval: number = 60000,
): UseDashboardReturn {
	const [data, setData] = useState<DashboardResponse | null>(cachedData);
	// Only ever true with nothing to show. With a cached payload the refresh is
	// silent — swapping numbers for a spinner you already have is a downgrade.
	const [isLoading, setIsLoading] = useState(cachedData === null);
	const [error, setError] = useState<string | null>(null);
	const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const fetchDashboard = useCallback(async () => {
		setError(null);
		try {
			const result = await fetchOnce();
			setData(result);
			// The server answered from its own cache while rebuilding; come back
			// for the rebuilt numbers rather than sitting on them until the next
			// poll, which could be a full interval away.
			if (result?.stale) {
				if (staleTimer.current) clearTimeout(staleTimer.current);
				staleTimer.current = setTimeout(() => {
					fetchOnce()
						.then(setData)
						.catch(() => {});
				}, STALE_REFETCH_MS);
			}
		} catch (err) {
			if (!isTransientNetworkError(err)) {
				setError(err instanceof Error ? err.message : "Unknown error");
			}
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchDashboard();

		const interval = setInterval(fetchDashboard, refreshInterval);
		return () => {
			clearInterval(interval);
			if (staleTimer.current) clearTimeout(staleTimer.current);
		};
	}, [fetchDashboard, refreshInterval]);

	return {
		data,
		isLoading,
		error,
		refetch: fetchDashboard,
	};
}
