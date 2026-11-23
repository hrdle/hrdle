import { storageKey } from "./app-storage";

const KEY = "input-history";
const LIMIT = 50;

/**
 * What was typed and sent, newest first. One list for every place that sends
 * a prompt - the terminal's input bar and the chat composer - so a prompt
 * sent from one can be picked again from the other.
 */
export function loadInputHistory(): string[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(storageKey(KEY)) || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** Moves `text` to the front, dropping its older copy, and persists. */
export function pushInputHistory(history: string[], text: string): string[] {
	const next = [text, ...history.filter((item) => item !== text)].slice(
		0,
		LIMIT,
	);
	try {
		localStorage.setItem(storageKey(KEY), JSON.stringify(next));
	} catch {}
	return next;
}
