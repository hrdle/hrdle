import { useCallback, useEffect, useState } from "react";

const supported = "serviceWorker" in navigator;

// Is the page under service-worker control? On a first-ever visit it is not:
// registration happens on `load` and the worker then claims the page, firing a
// `controllerchange` that means "now controlled", not "new release". Swallow
// that one — but only that one, so a genuine swap later in the same page
// session still prompts.
let hasController = supported && navigator.serviceWorker.controller !== null;

// How often to re-check sw.js while a tab stays open. Tablets are often left on
// the same page for hours, so a release would otherwise go unnoticed until the
// next manual reload.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// The worker can take over before React has mounted — index.html kicks off a
// `registration.update()` on load, and this bundle is large enough that the
// event can land first. So subscribe at module scope (main.tsx imports this
// before it renders) and replay the result into whichever hook mounts later.
let updateDetected = false;
const listeners = new Set<() => void>();

if (supported) {
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!hasController) {
			hasController = true;
			return;
		}
		console.log("[CC Hub] SW: new version activated, prompting for reload");
		updateDetected = true;
		for (const listener of listeners) listener();
	});
}

interface ServiceWorkerUpdate {
	/** A newer build has been precached and its worker has taken over. */
	updateAvailable: boolean;
	/** Hide the prompt; it reappears only if another release is detected. */
	dismiss: () => void;
	/** Reload so the page is served from the new worker's precache. */
	reload: () => void;
}

/**
 * Reports that a new release's service worker has taken control.
 *
 * The generated worker uses `skipWaiting()` + `clientsClaim()` (vite-plugin-pwa
 * `registerType: 'autoUpdate'`), so it swaps itself in as soon as the new build
 * is precached. The page keeps running the old bundle until it reloads — and
 * reloading a terminal out from under the user is hostile, so we ask first.
 */
export function useServiceWorkerUpdate(): ServiceWorkerUpdate {
	const [updateAvailable, setUpdateAvailable] = useState(updateDetected);

	useEffect(() => {
		if (!supported) return;

		const onUpdate = () => setUpdateAvailable(true);
		listeners.add(onUpdate);
		// The worker may have taken over between render and this effect.
		if (updateDetected) setUpdateAvailable(true);

		const checkForUpdate = () => {
			if (document.visibilityState !== "visible") return;
			navigator.serviceWorker
				.getRegistration()
				.then((reg) => reg?.update())
				.catch(() => {
					// Offline or the worker is gone — the next check retries.
				});
		};
		document.addEventListener("visibilitychange", checkForUpdate);
		const timer = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);

		return () => {
			listeners.delete(onUpdate);
			document.removeEventListener("visibilitychange", checkForUpdate);
			window.clearInterval(timer);
		};
	}, []);

	const dismiss = useCallback(() => {
		updateDetected = false;
		setUpdateAvailable(false);
	}, []);
	const reload = useCallback(() => window.location.reload(), []);

	return { updateAvailable, dismiss, reload };
}
