import { useEffect, useState } from "react";
import { authFetch } from "../services/api";

/**
 * Fetches a URL with the Bearer auth token, exposes the body as a same-origin
 * blob: URL, and revokes the URL when the input changes or the component
 * unmounts. Returns `null` while loading or on error.
 *
 * The `/api/files/raw|download` routes sit behind header-only auth, so an
 * `<img src>` / `<video src>` / `<a href>` cannot reach them when HRDLE_PASSWORD
 * is set. This hook fixes that without changing server semantics by routing
 * the actual GET through authFetch.
 */
export function useAuthBlobUrl(
	url: string | null | undefined,
	timeoutMs = 300_000,
): string | null {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);

	useEffect(() => {
		if (!url) {
			setBlobUrl(null);
			return;
		}
		let cancelled = false;
		let created: string | null = null;

		(async () => {
			try {
				const res = await authFetch(url, {}, timeoutMs);
				if (!res.ok) {
					if (!cancelled) setBlobUrl(null);
					return;
				}
				const blob = await res.blob();
				if (cancelled) return;
				created = URL.createObjectURL(blob);
				setBlobUrl(created);
			} catch {
				if (!cancelled) setBlobUrl(null);
			}
		})();

		return () => {
			cancelled = true;
			if (created) URL.revokeObjectURL(created);
		};
	}, [url, timeoutMs]);

	return blobUrl;
}
