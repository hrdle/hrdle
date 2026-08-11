import { LOCAL_PEER_ID } from "../../../shared/types";

export const NOTIFICATION_NAVIGATION_EVENT = "hrdle-notification-click";

export interface NotificationTarget {
	sessionId: string;
	peerId?: string;
}

export interface NotificationSession {
	id: string;
	ccSessionId?: string;
	agentSessionId?: string;
	peerId?: string;
}

function normalizedPeerId(peerId?: string): string {
	return peerId || LOCAL_PEER_ID;
}

export function isSameNotificationPeer(
	leftPeerId?: string,
	rightPeerId?: string,
): boolean {
	return normalizedPeerId(leftPeerId) === normalizedPeerId(rightPeerId);
}

export function parseNotificationTarget(
	search: string,
): NotificationTarget | null {
	const params = new URLSearchParams(search);
	const sessionId = params.get("notify-session");
	if (!sessionId) return null;
	const peerId = params.get("notify-peer") || undefined;
	return { sessionId, peerId };
}

export function findNotificationSession<T extends NotificationSession>(
	sessions: readonly T[],
	target: NotificationTarget,
): T | undefined {
	const idMatches = sessions.filter(
		(session) =>
			session.ccSessionId === target.sessionId ||
			session.agentSessionId === target.sessionId,
	);
	if (target.peerId) {
		return idMatches.find(
			(session) =>
				isSameNotificationPeer(session.peerId, target.peerId),
		);
	}
	return (
		idMatches.find(
			(session) => normalizedPeerId(session.peerId) === LOCAL_PEER_ID,
		) ?? idMatches[0]
	);
}

export function dispatchNotificationNavigation(target: NotificationTarget) {
	window.dispatchEvent(
		new CustomEvent<NotificationTarget>(NOTIFICATION_NAVIGATION_EVENT, {
			detail: target,
		}),
	);
}
