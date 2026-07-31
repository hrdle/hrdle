/**
 * Subscribe this browser to Web Push.
 *
 * Notifications have always been fired by the page from a mux WebSocket
 * message, which works exactly as long as the page is running. On Android it
 * usually is not: the tab freezes when the screen goes off, its keepalive
 * stops, and the server drops the socket as a zombie a minute later. Measured
 * on 2026-07-31 the phone's socket was opening and closing every couple of
 * minutes, so most hook events were broadcast to nobody at all.
 *
 * A push is handed to the operating system by the browser's push service, so it
 * arrives with nothing of ours awake. The service worker already knows what to
 * do with a notification — `sw-notification.js` has handled the click, and the
 * deep link into a session, since long before this.
 *
 * Idempotent and quiet. Called on every load, it re-registers what is already
 * there (the server keys on endpoint, so a repeat is a replace) and returns
 * silently when the browser cannot do it, permission is not granted, or the
 * server has no keys.
 */

import { storageKey } from "./app-storage";

const TOKEN_KEY = storageKey("token");

/** VAPID keys travel base64url; `applicationServerKey` wants the bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
	const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const token = localStorage.getItem(TOKEN_KEY);
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

export type PushSetupResult =
	| "subscribed"
	| "unsupported"
	| "no-permission"
	| "no-server-key"
	| "failed";

export async function ensurePushSubscription(): Promise<PushSetupResult> {
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
	if (!("Notification" in window) || Notification.permission !== "granted") {
		// Nothing is asked for here. The permission prompt belongs to whatever
		// the user just clicked, not to a page load.
		return "no-permission";
	}

	try {
		const keyRes = await fetch("/api/push/key", { headers: authHeaders() });
		if (!keyRes.ok) return "no-server-key";
		const { publicKey } = (await keyRes.json()) as { publicKey?: string };
		if (!publicKey) return "no-server-key";

		const registration = await navigator.serviceWorker.ready;
		const wanted = urlBase64ToUint8Array(publicKey);

		// `subscribe()` returns the existing subscription when the key matches,
		// and throws `InvalidStateError` when it does not — so a subscription
		// left over from a different key has to go first. That happens when the
		// server's keys are regenerated, and until it is dropped every push to
		// this device fails silently.
		const existing = await registration.pushManager.getSubscription();
		if (existing) {
			const key = existing.options.applicationServerKey;
			const same = key && new Uint8Array(key).toString() === wanted.toString();
			if (!same) await existing.unsubscribe();
		}

		const sub = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: wanted as BufferSource,
		});

		const res = await fetch("/api/push/subscribe", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ ...sub.toJSON(), label: navigator.userAgent.slice(0, 120) }),
		});
		return res.ok ? "subscribed" : "failed";
	} catch (err) {
		console.warn("[push] subscribe failed:", err);
		return "failed";
	}
}
