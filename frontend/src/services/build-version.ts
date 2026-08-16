/**
 * Whether the page is older than the server it is talking to.
 *
 * Its own module, with no service-worker import: the callers are a WebSocket
 * handler and a peer watcher, and pulling `virtual:pwa-register` into them
 * breaks every unit test that touches those files - vite resolves that module,
 * the test runner cannot.
 *
 * This never claims an update. The prompt's reload needs a worker that has
 * actually precached the new build, so all this does is make the worker look
 * now, and the ordinary path reports it once there is something to report.
 */

/** Asked at most this often: it is a network request for `sw.js`, and the
 *  message this rides on arrives every five seconds. */
const COOLDOWN_MS = 30_000;

let checkNow: (() => void) | null = null;
let lastCheck = 0;

export function setUpdateChecker(check: () => void): void {
	checkNow = check;
}

export function noteServerVersion(version: string | undefined): void {
	if (!version || version === __APP_VERSION__) return;
	if (Date.now() - lastCheck < COOLDOWN_MS) return;
	lastCheck = Date.now();
	checkNow?.();
}
