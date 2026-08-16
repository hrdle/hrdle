import { useCallback, useEffect, useState } from "react";
import { registerSW } from "virtual:pwa-register";

// How often to re-check sw.js while a tab stays open. Tablets are often left on
// the same page for hours, so a release would otherwise go unnoticed until the
// next manual reload.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Registration happens at module scope (main.tsx imports this before it renders)
// so the worker is picked up whether or not React has mounted yet, and a worker
// that is already waiting from a previous visit is reported immediately.
let updateDetected = false;
/**
 * Whether the full prompt has been waved away.
 *
 * Separate from `updateDetected`, which used to be cleared by dismissing: the
 * page was then on the old build with nothing left saying so, and the next
 * release's fix looked like a fix that had not worked. A dismissal hides the
 * card, not the fact.
 */
let updateDismissed = false;
const listeners = new Set<() => void>();

const updateServiceWorker = registerSW({
	onNeedRefresh() {
		console.log("[Hrdle] SW: new version waiting, prompting for reload");
		updateDetected = true;
		updateDismissed = false;
		for (const listener of listeners) listener();
	},
	onRegisterError(error) {
		// Without this the registration failure is swallowed and the app silently
		// loses update detection.
		console.error("[Hrdle] SW: registration failed", error);
	},
	onRegisteredSW(_swUrl, registration) {
		if (!registration) return;
		const check = () => {
			if (document.visibilityState !== "visible") return;
			registration.update().catch(() => {
				// Offline or the worker is gone — the next check retries.
			});
		};
		document.addEventListener("visibilitychange", check);
		window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
	},
});

interface ServiceWorkerUpdate {
	/** A newer build has been precached and its worker is waiting to take over. */
	updateAvailable: boolean;
	/** The card has been waved away. The update itself has not gone anywhere,
	 *  so what is left is a marker rather than nothing. */
	dismissed: boolean;
	dismiss: () => void;
	/** Activate the waiting worker and reload onto the new build. */
	reload: () => void;
}

/**
 * Reports that a new release's service worker is installed and waiting.
 *
 * The worker is generated in `prompt` mode, so it never activates on its own —
 * `registerSW`'s returned callback posts SKIP_WAITING and reloads once the user
 * accepts. That matters because a worker relying on `skipWaiting()` was
 * observed to stay in `waiting` indefinitely while a tab was open, which left
 * the page on the old build forever.
 */
export function useServiceWorkerUpdate(): ServiceWorkerUpdate {
	const [updateAvailable, setUpdateAvailable] = useState(updateDetected);
	const [dismissed, setDismissed] = useState(updateDismissed);

	useEffect(() => {
		const onUpdate = () => {
			setUpdateAvailable(true);
			setDismissed(updateDismissed);
		};
		listeners.add(onUpdate);
		// The worker may have started waiting between render and this effect.
		if (updateDetected) setUpdateAvailable(true);
		return () => {
			listeners.delete(onUpdate);
		};
	}, []);

	const dismiss = useCallback(() => {
		updateDismissed = true;
		setDismissed(true);
	}, []);
	const reload = useCallback(() => {
		void updateServiceWorker(true);
	}, []);

	return { updateAvailable, dismissed, dismiss, reload };
}
