import { useCallback, useEffect, useState } from "react";
import type { DashboardResponse } from "../../../shared/types";
import { authFetch, isTransientNetworkError } from "../services/api";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface PeerServerMetrics {
	systemMetrics?: DashboardResponse["systemMetrics"];
	diskUsage?: DashboardResponse["diskUsage"];
	connectedClients?: number;
	herdrUpdate?: DashboardResponse["herdrUpdate"];
	hrdleUpdate?: DashboardResponse["hrdleUpdate"];
}

interface UsePeerServerMetricsReturn extends PeerServerMetrics {
	isLoading: boolean;
	error: string | null;
	refetch: () => Promise<void>;
}

/**
 * Fetch the server-info slice of a peer's dashboard payload
 * (systemMetrics / diskUsage / connectedClients) on a polling interval.
 * Other dashboard fields (usage limits, daily activity, etc.) are intentionally
 * ignored — those live in the local-only top-level dashboard.
 */
export function usePeerServerMetrics(
	peerId: string,
	refreshInterval: number = 30000,
): UsePeerServerMetricsReturn {
	const [metrics, setMetrics] = useState<PeerServerMetrics>({});
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchMetrics = useCallback(async () => {
		try {
			const url = `${API_BASE}/api/peers/${encodeURIComponent(peerId)}/dashboard`;
			const response = await authFetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const data = (await response.json()) as DashboardResponse;
			setMetrics({
				systemMetrics: data.systemMetrics,
				diskUsage: data.diskUsage,
				connectedClients: data.connectedClients,
				herdrUpdate: data.herdrUpdate,
				hrdleUpdate: data.hrdleUpdate,
			});
			setError(null);
		} catch (err) {
			if (!isTransientNetworkError(err)) {
				setError(err instanceof Error ? err.message : "Unknown error");
			}
		} finally {
			setIsLoading(false);
		}
	}, [peerId]);

	useEffect(() => {
		setIsLoading(true);
		fetchMetrics();
		const interval = setInterval(fetchMetrics, refreshInterval);
		return () => clearInterval(interval);
	}, [fetchMetrics, refreshInterval]);

	return {
		...metrics,
		isLoading,
		error,
		refetch: fetchMetrics,
	};
}
