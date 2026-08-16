import { useSyncExternalStore } from "react";

/**
 * When the steward started working on something, per conversation.
 *
 * Module state rather than a hook's, because the two halves are not in one
 * React subtree: on a phone the composer that shows the indicator lives in the
 * fixed bottom bar and the turns it belongs to are in the pane area above.
 *
 * The key is the session id, or the empty string for the overview.
 */
const startedAt = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
	for (const l of listeners) l();
}

export function markThinking(key: string, at = Date.now()): void {
	startedAt.set(key, at);
	emit();
}

export function clearThinking(key: string): void {
	if (startedAt.delete(key)) emit();
}

export function useThinkingSince(key: string): number | null {
	return useSyncExternalStore(
		(onChange) => {
			listeners.add(onChange);
			return () => listeners.delete(onChange);
		},
		() => startedAt.get(key) ?? null,
		() => null,
	);
}
