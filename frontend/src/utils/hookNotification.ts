/**
 * Fires an OS notification when a hook event arrives.
 * In a PWA this goes through ServiceWorkerRegistration.showNotification().
 * Debounced, so several instances calling at once still produce one notification.
 */

import { toHomeShortPath } from "./path";
import {
	dispatchNotificationNavigation,
	isSameNotificationPeer,
} from "./notificationNavigation";
import { isPushActive } from "./webPush";
import { IDENTITY } from "../../../shared/identity";
import { LOCAL_PEER_ID } from "../../../shared/types";

const EVENT_MESSAGES: Record<string, string> = {
	Stop: "Response complete",
	Notification: "Waiting for your input",
	SubagentStop: "Subagent finished",
	TaskCompleted: "Task complete",
	PostToolUse: "Waiting for your input",
};

// Debounce: the same event + cwd pair does not fire twice within 500ms
let lastNotification = { key: "", time: 0 };
const DEBOUNCE_MS = 500;

async function showNotification(title: string, options: NotificationOptions) {
	// 1. Try ServiceWorker (required for PWA / installed web apps)
	if ("serviceWorker" in navigator) {
		try {
			const registration = await navigator.serviceWorker.getRegistration();
			if (registration) {
				await registration.showNotification(title, options);
				return;
			}
		} catch {
			// Fall through to Notification constructor
		}
	}

	// 2. Fallback: Notification constructor (works in regular browser tabs)
	try {
		const notification = new Notification(title, options);
		notification.onclick = () => {
			window.focus();
			const sessionId = options.data?.sessionId;
			if (typeof sessionId === "string") {
				dispatchNotificationNavigation({
					sessionId,
					peerId:
						typeof options.data?.peerId === "string"
							? options.data.peerId
							: undefined,
				});
			}
			notification.close();
		};
	} catch {
		// Notification not supported in this context
	}
}

/**
 * Builds an OS notification from a hook event.
 */
export function fireHookNotification(
	event: string,
	cwd?: string,
	_sessionId?: string,
	_data?: Record<string, unknown>,
	smartMessage?: string,
	peerId?: string,
) {
	if (!("Notification" in window) || Notification.permission !== "granted") {
		return;
	}

	// One hook event reaches a subscribed device twice: once here, from the mux
	// broadcast, and once from the server's own Web Push. Both paths are there
	// for a reason — a frozen tab receives no broadcast, and a push establishes
	// nothing about whether the page is running — but where both are live they
	// are the same notification, a second apart (#331).
	//
	// The page is the side that yields, because push is strictly the wider
	// channel: it arrives with the page closed, so nothing is lost by staying
	// quiet here. This is not the `deliveredToGlasses` dilemma — whether *this*
	// browser holds an accepted subscription is a local fact, not an inference
	// about someone's face.
	//
	// Only for events from this server. A peer pushes to the browsers that
	// subscribed *there*, which this one did not, so a peer's notification has
	// this path and no other.
	if (isSameNotificationPeer(peerId, LOCAL_PEER_ID) && isPushActive()) {
		return;
	}

	// Debounce
	const key = `${peerId || "local"}:${_sessionId || ""}:${event}:${cwd || ""}`;
	const now = Date.now();
	if (
		key === lastNotification.key &&
		now - lastNotification.time < DEBOUNCE_MS
	) {
		return;
	}
	lastNotification = { key, time: now };

	// Title: project/directory name (e.g. "~/lifestyle-app-work-1")
	const projectName = toHomeShortPath(cwd) || IDENTITY.productName;
	// Body: smart message from transcript, or fallback
	const body = smartMessage || EVENT_MESSAGES[event] || `Hook: ${event}`;

	showNotification(projectName, {
		body,
		icon: "/icon-192.png",
		tag: `hook-${event}-${now}`,
		data: { sessionId: _sessionId, peerId, event },
	});
}
