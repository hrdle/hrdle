/**
 * A cache that never makes the second caller wait for the first one's data.
 *
 * The caches already scattered through the services all block on expiry: past
 * the TTL, the next caller pays the full rebuild. That is the right shape when
 * requests arrive steadily, and the wrong one when they arrive in bursts
 * separated by long silences — which is exactly how a panel that unmounts when
 * closed asks for its data. The TTL has always lapsed by the time it is
 * reopened, so the common case is the worst case, every time.
 *
 * Here a lapsed entry is served anyway, and the rebuild runs behind it. Only a
 * caller with nothing cached at all waits.
 */
export interface StaleWhileRevalidate<T> {
	/** Cached value if there is one, rebuilding behind the answer when lapsed. */
	get(): Promise<{ value: T; stale: boolean }>;
	/** Drop the entry so the next `get` rebuilds and waits. */
	invalidate(): void;
}

export function staleWhileRevalidate<T>(
	build: () => Promise<T>,
	ttlMs: number,
): StaleWhileRevalidate<T> {
	let cached: { value: T; at: number } | null = null;
	let building: Promise<T> | null = null;

	// Coalesced: concurrent callers past the TTL share one rebuild rather than
	// each starting their own.
	function rebuild(): Promise<T> {
		building ??= build()
			.then((value) => {
				cached = { value, at: Date.now() };
				return value;
			})
			.finally(() => {
				building = null;
			});
		return building;
	}

	return {
		async get() {
			if (!cached) return { value: await rebuild(), stale: false };
			if (Date.now() - cached.at < ttlMs) {
				return { value: cached.value, stale: false };
			}
			// A failed background rebuild leaves the previous value in place. That
			// is deliberate: stale data beats an error page for something a user is
			// glancing at, and every service-level cache underneath already does
			// the same on failure.
			void rebuild().catch(() => {});
			return { value: cached.value, stale: true };
		},
		invalidate() {
			cached = null;
		},
	};
}
