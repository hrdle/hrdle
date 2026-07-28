import { storageKey } from "./app-storage";
export const UI_SCALE_STORAGE_KEY = storageKey("ui-scale");
export const UI_SCALE_OPTIONS = [0.8, 0.9, 1.0, 1.15, 1.3] as const;
const DEFAULT_UI_SCALE = 1.0;
const BASE_FONT_SIZE_PX = 14;

export function getStoredUiScale(): number {
	try {
		const stored = localStorage.getItem(UI_SCALE_STORAGE_KEY);
		if (stored) {
			const n = parseFloat(stored);
			if (
				!Number.isNaN(n) &&
				(UI_SCALE_OPTIONS as readonly number[]).includes(n)
			) {
				return n;
			}
		}
	} catch {
		// ignore
	}
	return DEFAULT_UI_SCALE;
}

export function applyUiScale(scale: number): void {
	document.documentElement.style.fontSize = `${BASE_FONT_SIZE_PX * scale}px`;
}
