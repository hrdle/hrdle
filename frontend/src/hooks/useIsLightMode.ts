import { useEffect, useState } from "react";

/**
 * Tracks the `data-theme` attribute the theme toggle stamps on `<html>`.
 *
 * SVG charts pick their grid and background colours in JS rather than CSS, so
 * they need the theme as a value. Two copies of this had drifted into
 * `UsageChart` and `ServerInfo`.
 */
export function useIsLightMode(): boolean {
	const [light, setLight] = useState(
		() => document.documentElement.getAttribute("data-theme") === "light",
	);
	useEffect(() => {
		const observer = new MutationObserver(() => {
			setLight(document.documentElement.getAttribute("data-theme") === "light");
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		return () => observer.disconnect();
	}, []);
	return light;
}
