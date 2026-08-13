import { describe, expect, test } from "bun:test";
import {
	filterMouseTrackingInput,
	isAppShortcut,
	shouldInterceptKeyEvent,
} from "../terminal-filters";

// ---------------------------------------------------------------------------
// filterMouseTrackingInput
// ---------------------------------------------------------------------------
describe("filterMouseTrackingInput", () => {
	test("passes through normal text", () => {
		expect(filterMouseTrackingInput("hello world")).toBe("hello world");
	});

	test("passes through normal escape sequences (e.g. cursor movement)", () => {
		const cursorUp = "\x1b[A";
		const cursorDown = "\x1b[B";
		expect(filterMouseTrackingInput(cursorUp)).toBe(cursorUp);
		expect(filterMouseTrackingInput(cursorDown)).toBe(cursorDown);
	});

	test("strips SGR mouse button press \\x1b[<0;5;3M", () => {
		expect(filterMouseTrackingInput("\x1b[<0;5;3M")).toBe("");
	});

	test("strips SGR mouse button release \\x1b[<0;5;3m", () => {
		expect(filterMouseTrackingInput("\x1b[<0;5;3m")).toBe("");
	});

	test("strips SGR mouse scroll \\x1b[<64;10;20M", () => {
		expect(filterMouseTrackingInput("\x1b[<64;10;20M")).toBe("");
	});

	test("strips SGR mouse motion with large coordinates", () => {
		expect(filterMouseTrackingInput("\x1b[<32;255;100M")).toBe("");
	});

	test("strips legacy X10 mouse report \\x1b[M...", () => {
		// X10 format: \x1b[M followed by exactly 3 bytes (button, col, row)
		expect(filterMouseTrackingInput("\x1b[M #!")).toBe("");
	});

	test("strips mouse sequences embedded in normal text", () => {
		const input = "before\x1b[<0;5;3Mafter";
		expect(filterMouseTrackingInput(input)).toBe("beforeafter");
	});

	test("strips multiple mouse sequences", () => {
		const input = "\x1b[<0;1;1M\x1b[<0;1;1m";
		expect(filterMouseTrackingInput(input)).toBe("");
	});

	test("preserves bracketed paste sequences", () => {
		const paste = "\x1b[200~pasted text\x1b[201~";
		expect(filterMouseTrackingInput(paste)).toBe(paste);
	});

	test("preserves Japanese text", () => {
		const japanese = "こんにちは世界";
		expect(filterMouseTrackingInput(japanese)).toBe(japanese);
	});

	test("preserves empty string", () => {
		expect(filterMouseTrackingInput("")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// shouldInterceptKeyEvent
// ---------------------------------------------------------------------------
describe("shouldInterceptKeyEvent", () => {
	// Helper to create a mock key event
	const mkEvent = (
		overrides: Partial<{
			type: string;
			key: string;
			ctrlKey: boolean;
			metaKey: boolean;
			shiftKey: boolean;
			altKey: boolean;
		}> = {},
	) => ({
		type: "keydown",
		key: "",
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...overrides,
	});

	test('intercepts Shift+Enter as "shift-enter"', () => {
		expect(
			shouldInterceptKeyEvent(mkEvent({ shiftKey: true, key: "Enter" })),
		).toBe("shift-enter");
	});

	test('intercepts Ctrl+V as "paste"', () => {
		expect(shouldInterceptKeyEvent(mkEvent({ ctrlKey: true, key: "v" }))).toBe(
			"paste",
		);
	});

	test('intercepts Cmd+V (metaKey) as "paste"', () => {
		expect(shouldInterceptKeyEvent(mkEvent({ metaKey: true, key: "v" }))).toBe(
			"paste",
		);
	});

	test("intercepts uppercase V with Ctrl", () => {
		// e.key is 'V' when Caps Lock is on
		expect(shouldInterceptKeyEvent(mkEvent({ ctrlKey: true, key: "V" }))).toBe(
			"paste",
		);
	});

	test("does NOT intercept Ctrl+Shift+V (we only intercept without shift)", () => {
		expect(
			shouldInterceptKeyEvent(
				mkEvent({ ctrlKey: true, shiftKey: true, key: "v" }),
			),
		).toBe(null);
	});

	test("does NOT intercept Ctrl+C (should go through to xterm for SIGINT)", () => {
		expect(shouldInterceptKeyEvent(mkEvent({ ctrlKey: true, key: "c" }))).toBe(
			null,
		);
	});

	test("does NOT intercept Ctrl+D", () => {
		expect(shouldInterceptKeyEvent(mkEvent({ ctrlKey: true, key: "d" }))).toBe(
			null,
		);
	});

	test("does NOT intercept regular Enter (without Shift)", () => {
		expect(shouldInterceptKeyEvent(mkEvent({ key: "Enter" }))).toBe(null);
	});

	test("does NOT intercept regular character keys", () => {
		expect(shouldInterceptKeyEvent(mkEvent({ key: "a" }))).toBe(null);
		expect(shouldInterceptKeyEvent(mkEvent({ key: "1" }))).toBe(null);
	});

	test("does NOT intercept keyup events", () => {
		expect(
			shouldInterceptKeyEvent(
				mkEvent({ type: "keyup", ctrlKey: true, key: "v" }),
			),
		).toBe(null);
		expect(
			shouldInterceptKeyEvent(
				mkEvent({ type: "keyup", shiftKey: true, key: "Enter" }),
			),
		).toBe(null);
	});

	test("does NOT intercept arrow keys without modifier", () => {
		expect(shouldInterceptKeyEvent(mkEvent({ key: "ArrowUp" }))).toBe(null);
		expect(shouldInterceptKeyEvent(mkEvent({ key: "ArrowDown" }))).toBe(null);
	});

	test('reports an app shortcut as "app-shortcut"', () => {
		expect(shouldInterceptKeyEvent(mkEvent({ ctrlKey: true, key: "b" }))).toBe(
			"app-shortcut",
		);
	});

	test("Ctrl+C without a selection still outranks the app-shortcut check", () => {
		expect(shouldInterceptKeyEvent(mkEvent({ ctrlKey: true, key: "c" }))).toBe(
			null,
		);
	});
});

// ---------------------------------------------------------------------------
// isAppShortcut
// ---------------------------------------------------------------------------
describe("isAppShortcut", () => {
	const key = (
		k: string,
		mods: Partial<{
			ctrlKey: boolean;
			metaKey: boolean;
			shiftKey: boolean;
			altKey: boolean;
		}> = {},
	) => ({
		key: k,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...mods,
	});

	// Every chord DesktopLayout's window listener acts on. A chord missing from
	// isAppShortcut is one xterm may eat before the listener runs.
	const owned: Array<[string, ReturnType<typeof key>]> = [
		["Ctrl+B (sessions)", key("b", { ctrlKey: true })],
		["Ctrl+Shift+B (dashboard)", key("B", { ctrlKey: true, shiftKey: true })],
		["Ctrl+Shift+E (split right)", key("E", { ctrlKey: true, shiftKey: true })],
		["Ctrl+Shift+D (split down)", key("D", { ctrlKey: true, shiftKey: true })],
		["Ctrl+Shift+X (close pane)", key("X", { ctrlKey: true, shiftKey: true })],
		[
			"Ctrl+Shift+Right (resize)",
			key("ArrowRight", { ctrlKey: true, shiftKey: true }),
		],
		["Ctrl+Shift+= (equalize)", key("=", { ctrlKey: true, shiftKey: true })],
		["Ctrl+Shift+F5 (cache clear)", key("F5", { ctrlKey: true, shiftKey: true })],
		["Ctrl+= (font size up)", key("=", { ctrlKey: true })],
		["Ctrl+- (font size down)", key("-", { ctrlKey: true })],
		["Ctrl+0 (font size reset)", key("0", { ctrlKey: true })],
		["Ctrl+3 (switch session)", key("3", { ctrlKey: true })],
		["Alt+Left (focus a pane)", key("ArrowLeft", { altKey: true })],
		["Cmd+B (sessions, mac)", key("b", { metaKey: true })],
	];
	for (const [name, event] of owned) {
		test(`claims ${name}`, () => {
			expect(isAppShortcut(event)).toBe(true);
		});
	}

	// The pane needs these more than the app does — taking them costs EOF,
	// delete-word and word motion, with nothing left to send them with.
	const leftToThePane: Array<[string, ReturnType<typeof key>]> = [
		["Ctrl+D", key("d", { ctrlKey: true })],
		["Ctrl+W", key("w", { ctrlKey: true })],
		["Ctrl+Left", key("ArrowLeft", { ctrlKey: true })],
		["Ctrl+Right", key("ArrowRight", { ctrlKey: true })],
		["Ctrl+A", key("a", { ctrlKey: true })],
		["Ctrl+Alt+B", key("b", { ctrlKey: true, altKey: true })],
		["a bare letter", key("b")],
		["a bare arrow", key("ArrowUp")],
	];
	for (const [name, event] of leftToThePane) {
		test(`leaves ${name} to the pane`, () => {
			expect(isAppShortcut(event)).toBe(false);
		});
	}
});
