import type { SessionTheme } from "../../../shared/types";
import { storageKey } from "../utils/app-storage";

// Terminal theme colors based on session theme (dark mode)
const TERMINAL_THEMES_DARK: Record<
	SessionTheme | "default",
	{ background: string; foreground: string; accent: string }
> = {
	default: { background: "#1a1a1a", foreground: "#efefef", accent: "#1a1a1a" },
	red: { background: "#3d1a1f", foreground: "#efefef", accent: "#7f1d1d" },
	orange: { background: "#3d2415", foreground: "#efefef", accent: "#7c2d12" },
	amber: { background: "#3d3012", foreground: "#efefef", accent: "#78350f" },
	green: { background: "#153d20", foreground: "#efefef", accent: "#14532d" },
	teal: { background: "#153d35", foreground: "#efefef", accent: "#134e4a" },
	blue: { background: "#15253d", foreground: "#efefef", accent: "#1e3a5f" },
	indigo: { background: "#221c3d", foreground: "#efefef", accent: "#312e81" },
	purple: { background: "#2d1a3d", foreground: "#efefef", accent: "#4c1d95" },
	pink: { background: "#3d1a2d", foreground: "#efefef", accent: "#831843" },
};

// Terminal theme colors (light mode) - soft bg, strong text
const TERMINAL_THEMES_LIGHT: Record<
	SessionTheme | "default",
	{ background: string; foreground: string; accent: string }
> = {
	default: { background: "#eff1f5", foreground: "#4c4f69", accent: "#eff1f5" },
	red: { background: "#f3eced", foreground: "#4c4f69", accent: "#d20f39" },
	orange: { background: "#f3eeeb", foreground: "#4c4f69", accent: "#fe640b" },
	amber: { background: "#f3f0e8", foreground: "#4c4f69", accent: "#df8e1d" },
	green: { background: "#ebf3ec", foreground: "#4c4f69", accent: "#40a02b" },
	teal: { background: "#ebf3f1", foreground: "#4c4f69", accent: "#179299" },
	blue: { background: "#ebeff3", foreground: "#4c4f69", accent: "#1e66f5" },
	indigo: { background: "#eeedf3", foreground: "#4c4f69", accent: "#7287fd" },
	purple: { background: "#f0edf3", foreground: "#4c4f69", accent: "#8839ef" },
	pink: { background: "#f3edef", foreground: "#4c4f69", accent: "#ea76cb" },
};

// Official Catppuccin Latte ANSI colors
export const LIGHT_ANSI_COLORS = {
	black: "#bcc0cc",
	red: "#d20f39",
	green: "#40a02b",
	yellow: "#df8e1d",
	blue: "#1e66f5",
	magenta: "#ea76cb",
	cyan: "#179299",
	white: "#5c5f77",
	brightBlack: "#acb0be",
	brightRed: "#d20f39",
	brightGreen: "#40a02b",
	brightYellow: "#df8e1d",
	brightBlue: "#1e66f5",
	brightMagenta: "#ea76cb",
	brightCyan: "#179299",
	brightWhite: "#6c6f85",
};

export function getTerminalThemes() {
	const isDark =
		document.documentElement.getAttribute("data-theme") !== "light";
	return isDark ? TERMINAL_THEMES_DARK : TERMINAL_THEMES_LIGHT;
}

export function isLightMode() {
	return document.documentElement.getAttribute("data-theme") === "light";
}

// Font size constants and helpers
const FONT_SIZE_KEY_PREFIX = storageKey("terminal-font-size-");
export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

export function loadFontSize(sessionId: string): number {
	const saved = localStorage.getItem(FONT_SIZE_KEY_PREFIX + sessionId);
	if (saved) {
		const size = parseInt(saved, 10);
		if (!Number.isNaN(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) {
			return size;
		}
	}
	return DEFAULT_FONT_SIZE;
}

export function saveFontSize(sessionId: string, size: number): void {
	localStorage.setItem(FONT_SIZE_KEY_PREFIX + sessionId, String(size));
}
