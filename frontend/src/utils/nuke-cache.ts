/**
 * Wipe every client-side cache and persistent storage Hrdle touches, then
 * hard-reload with a cache-busting query string. Used by the dashboard
 * "Clear cache" button and the Ctrl/Cmd+Shift+F5 keybinding when a PWA gets
 * stuck on an outdated bundle.
 *
 * Side effect: localStorage is cleared, so the user has to log in again.
 */
export async function nukeClientCache(): Promise<void> {
	// 1. Stop and unregister all Service Workers
	if ("serviceWorker" in navigator) {
		try {
			const regs = await navigator.serviceWorker.getRegistrations();
			await Promise.all(regs.map((r) => r.unregister()));
		} catch {
			/* permissions may deny */
		}
	}
	// 2. Drop every Cache API entry (precache, runtime, api-cache, ...)
	if (typeof caches !== "undefined") {
		try {
			const keys = await caches.keys();
			await Promise.all(keys.map((k) => caches.delete(k)));
		} catch {
			/* ignore */
		}
	}
	// 3. Wipe IndexedDB (PWA frameworks and some libs persist state here)
	if ("indexedDB" in window && typeof indexedDB.databases === "function") {
		try {
			const dbs = await indexedDB.databases();
			await Promise.all(
				dbs.map(
					(db) =>
						new Promise<void>((resolve) => {
							if (!db.name) return resolve();
							const req = indexedDB.deleteDatabase(db.name);
							const done = () => resolve();
							req.onsuccess = done;
							req.onerror = done;
							req.onblocked = done;
						}),
				),
			);
		} catch {
			/* ignore */
		}
	}
	// 4. Clear localStorage / sessionStorage (auth token included)
	try {
		localStorage.clear();
	} catch {
		/* private mode */
	}
	try {
		sessionStorage.clear();
	} catch {
		/* private mode */
	}
	// 5. Cache-busted hard reload — `?_nocache=…` prevents the browser from
	// satisfying the request from the memory/HTTP cache
	const url = new URL(`${location.origin}/`);
	url.searchParams.set("_nocache", Date.now().toString(36));
	location.replace(url.toString());
}
