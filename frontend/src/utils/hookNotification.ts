/**
 * hook イベントを受信した際にOS通知を発火する。
 * PWAではServiceWorkerRegistration.showNotification()を使用。
 * 複数のインスタンスから同時に呼ばれても
 * デバウンスで1回だけ通知する。
 */

import { toHomeShortPath } from "./path";
import { dispatchNotificationNavigation } from "./notificationNavigation";
import { IDENTITY } from "../../../shared/identity";

const EVENT_MESSAGES: Record<string, string> = {
	Stop: "応答が完了しました",
	Notification: "ユーザー入力を待っています",
	SubagentStop: "サブエージェントが完了しました",
	TaskCompleted: "タスクが完了しました",
	PostToolUse: "ユーザー入力を待っています",
};

// デバウンス: 同じイベント+cwdの組み合わせを500ms以内に重複発火しない
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
 * hookイベントからOS通知を生成する。
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

	// デバウンス
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
