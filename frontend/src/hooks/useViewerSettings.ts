import { useCallback, useState } from "react";
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
			return settings[fileName] ?? true; // デフォルトはtrue
		}
	} catch {
		// ignore
	}
	return true; // デフォルトはtrue
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
 * Centralizes the viewer settings that were previously copy-pasted across
 * CodeViewer / DiffViewer / MarkdownViewer: per-file word-wrap and a global
 * font size, both backed by localStorage.
 */
export function useViewerSettings(fileName?: string): ViewerSettings {
	const [wordWrap, setWordWrap] = useState(() =>
		getWordWrapSetting(fileName || ""),
	);
	const [fontSize, setFontSize] = useState(() => getFontSizeSetting());

	const toggleWordWrap = useCallback(() => {
		setWordWrap((prev) => {
			const next = !prev;
			if (fileName) {
				persistWordWrapSetting(fileName, next);
			}
			return next;
		});
	}, [fileName]);

	const commitFontSize = useCallback((size: number) => {
		setFontSize(size);
		persistFontSizeSetting(size);
	}, []);

	const resetFontSize = useCallback(() => {
		setFontSize(DEFAULT_FONTSIZE);
		persistFontSizeSetting(DEFAULT_FONTSIZE);
	}, []);

	return {
		wordWrap,
		toggleWordWrap,
		fontSize,
		setFontSize,
		commitFontSize,
		resetFontSize,
	};
}
