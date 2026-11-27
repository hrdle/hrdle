import { useCallback, useSyncExternalStore } from "react";
import { storageKey } from "../utils/app-storage";

const WORDWRAP_STORAGE_KEY = storageKey("wordwrap");
const FONTSIZE_STORAGE_KEY = storageKey("fontsize");

const DEFAULT_FONTSIZE = 14;
export const MIN_FONTSIZE = 8;
export const MAX_FONTSIZE = 32;

function getWordWrapSetting(fileName: string): boolean {
	try {
		const stored = localStorage.getItem(WORDWRAP_STORAGE_KEY);
		if (stored) {
			const settings = JSON.parse(stored);
			return settings[fileName] ?? true; // Defaults to true
		}
	} catch {
		// ignore
	}
	return true; // Defaults to true
}

function persistWordWrapSetting(fileName: string, value: boolean) {
	try {
		const stored = localStorage.getItem(WORDWRAP_STORAGE_KEY);
		const settings = stored ? JSON.parse(stored) : {};
		settings[fileName] = value;
		localStorage.setItem(WORDWRAP_STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// ignore
	}
}

function getFontSizeSetting(): number {
	try {
		const stored = localStorage.getItem(FONTSIZE_STORAGE_KEY);
		if (stored) {
			const size = parseInt(stored, 10);
			if (!Number.isNaN(size) && size >= MIN_FONTSIZE && size <= MAX_FONTSIZE) {
				return size;
			}
		}
	} catch {
		// ignore
	}
	return DEFAULT_FONTSIZE;
}

function persistFontSizeSetting(size: number) {
	try {
		localStorage.setItem(FONTSIZE_STORAGE_KEY, String(size));
	} catch {
		// ignore
	}
}

export interface ViewerSettings {
	/** Per-file word-wrap toggle (defaults to true). */
	wordWrap: boolean;
	toggleWordWrap: () => void;
	/** Global font size shared across all viewers. */
	fontSize: number;
	/** Update font size in state only — transient, e.g. mid pinch gesture. */
	setFontSize: (size: number) => void;
	/** Update font size and persist it to localStorage. */
	commitFontSize: (size: number) => void;
	/** Reset font size to the default and persist. */
	resetFontSize: () => void;
}

/**
 * One store for every viewer on the page. The settings are changed from the
 * file viewer's toolbar while the viewer showing the file reads them, so two
 * instances of this hook have to see the same values - per-instance state let
 * a toolbar change reach nothing until the file was opened again.
 */
let fontSizeState = getFontSizeSetting();
const wordWrapState = new Map<string, boolean>();
let version = 0;
const listeners = new Set<() => void>();

function emit() {
	version += 1;
	for (const l of listeners) l();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getVersion() {
	return version;
}

function wordWrapFor(fileName: string): boolean {
	let value = wordWrapState.get(fileName);
	if (value === undefined) {
		value = getWordWrapSetting(fileName);
		wordWrapState.set(fileName, value);
	}
	return value;
}

function setFontSizeShared(size: number) {
	fontSizeState = size;
	emit();
}

export function useViewerSettings(fileName?: string): ViewerSettings {
	useSyncExternalStore(subscribe, getVersion);
	const key = fileName || "";

	const toggleWordWrap = useCallback(() => {
		const next = !wordWrapFor(key);
		wordWrapState.set(key, next);
		if (key) persistWordWrapSetting(key, next);
		emit();
	}, [key]);

	const commitFontSize = useCallback((size: number) => {
		setFontSizeShared(size);
		persistFontSizeSetting(size);
	}, []);

	const resetFontSize = useCallback(() => {
		setFontSizeShared(DEFAULT_FONTSIZE);
		persistFontSizeSetting(DEFAULT_FONTSIZE);
	}, []);

	return {
		wordWrap: wordWrapFor(key),
		toggleWordWrap,
		fontSize: fontSizeState,
		setFontSize: setFontSizeShared,
		commitFontSize,
		resetFontSize,
	};
}
