import { useCallback, useEffect, useState } from "react";
import { storageKey } from "../utils/app-storage";

export type Theme = "light" | "dark";

const STORAGE_KEY = storageKey("theme");

function getStoredTheme(): Theme {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "light" || saved === "dark") return saved;
	} catch {}
	return "dark";
}

function applyTheme(theme: Theme) {
	document.documentElement.setAttribute("data-theme", theme);
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		meta.setAttribute("content", theme === "light" ? "#f8fafc" : "#1a1a1a");
	}
}

export function useTheme() {
	const [theme, setTheme] = useState<Theme>(getStoredTheme);

	useEffect(() => {
		applyTheme(theme);
		localStorage.setItem(STORAGE_KEY, theme);
	}, [theme]);

	const toggleTheme = useCallback(() => {
		setTheme((prev) => (prev === "dark" ? "light" : "dark"));
	}, []);

	const isDark = theme === "dark";

	return { theme, toggleTheme, isDark } as const;
}
