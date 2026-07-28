import { storageKey } from "./app-storage";
/**
 * Stable per-device identifier.
 *
 * Generated once on first load and persisted in `localStorage`. Used by the
 * mux WebSocket to let the server count unique devices instead of raw socket
 * connections (so multiple tabs on the same browser count as one).
 */

const STORAGE_KEY = storageKey("device-id");

export function getDeviceId(): string {
	try {
		const existing = localStorage.getItem(STORAGE_KEY);
		if (existing) return existing;
	} catch {
		// localStorage unavailable (private mode, etc.) — fall through to a
		// session-scoped fallback so the connection still has a deviceId.
	}

	const fresh =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `d_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

	try {
		localStorage.setItem(STORAGE_KEY, fresh);
	} catch {
		// non-persistent — still return the value for this session
	}
	return fresh;
}
