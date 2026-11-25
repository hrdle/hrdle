import { describe, expect, test } from "bun:test";
import { matchDesktopShortcut } from "./desktop-shortcuts";
import { isAppShortcut } from "./terminal-filters";

const chord = (
	key: string,
	mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
) => ({
	key,
	ctrlKey: mods.ctrl ?? false,
	metaKey: mods.meta ?? false,
	shiftKey: mods.shift ?? false,
	altKey: mods.alt ?? false,
});

describe("matchDesktopShortcut", () => {
	test.each([
		[chord("ArrowLeft", { alt: true }), { kind: "focus-pane", key: "ArrowLeft" }],
		[chord("E", { ctrl: true, shift: true }), { kind: "split", direction: "horizontal" }],
		[chord("D", { ctrl: true, shift: true }), { kind: "split", direction: "vertical" }],
		[chord("X", { ctrl: true, shift: true }), { kind: "close-pane" }],
		[chord("c", { meta: true }), { kind: "copy" }],
		[chord("v", { ctrl: true }), { kind: "paste" }],
		[chord("=", { ctrl: true }), { kind: "font-size", delta: 2 }],
		[chord("-", { ctrl: true }), { kind: "font-size", delta: -2 }],
		[chord("0", { ctrl: true }), { kind: "font-size-reset" }],
		[chord("b", { ctrl: true }), { kind: "toggle-session-modal" }],
		[chord("B", { ctrl: true, shift: true }), { kind: "toggle-dashboard" }],
		[
			chord("ArrowUp", { ctrl: true, shift: true }),
			{ kind: "resize-pane", direction: "U", amount: 3 },
		],
		[
			chord("ArrowRight", { ctrl: true, shift: true }),
			{ kind: "resize-pane", direction: "R", amount: 5 },
		],
		[chord("+", { ctrl: true, shift: true }), { kind: "equalize-panes" }],
		[chord("F5", { ctrl: true, shift: true }), { kind: "reload" }],
		[chord("3", { ctrl: true }), { kind: "switch-session", index: 2 }],
	])("%o", (e, expected) => {
		expect(matchDesktopShortcut(e)).toEqual(expected as never);
	});

	test("leaves the pane its own control keys", () => {
		expect(matchDesktopShortcut(chord("d", { ctrl: true }))).toBeNull();
		expect(matchDesktopShortcut(chord("w", { ctrl: true }))).toBeNull();
		expect(matchDesktopShortcut(chord("ArrowLeft", { ctrl: true }))).toBeNull();
		expect(matchDesktopShortcut(chord("e"))).toBeNull();
	});
});

// xterm swallows a chord it has a binding for, so a shortcut that
// isAppShortcut does not let through never reaches the window listener.
test("every shortcut except copy and paste gets past xterm", () => {
	const keys = [
		..."abcdefghijklmnopqrstuvwxyz0123456789=+-",
		"ArrowLeft",
		"ArrowRight",
		"ArrowUp",
		"ArrowDown",
		"F5",
	];
	const modifierSets = [
		{ ctrl: true },
		{ meta: true },
		{ ctrl: true, shift: true },
		{ meta: true, shift: true },
		{ alt: true },
	];
	for (const k of keys) {
		for (const mods of modifierSets) {
			const variants = mods.shift ? [k, k.toUpperCase()] : [k];
			for (const key of variants) {
				const e = chord(key, mods);
				const shortcut = matchDesktopShortcut(e);
				if (!shortcut || shortcut.kind === "copy" || shortcut.kind === "paste")
					continue;
				expect({ key, mods, passes: isAppShortcut(e) }).toEqual({
					key,
					mods,
					passes: true,
				});
			}
		}
	}
});
