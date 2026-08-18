import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Who is speaking, on the screens where the steward is read.
 *
 * There were two surfaces for three speakers: the person's own turn on
 * `bubble`, and everything else - the steward's own words *and* an
 * agent-derived summary of what happened in a session - on `surface`, which
 * sits 9/255 away from the page behind it. A reply arrived, was invisible, and
 * the steward was asked why it had not answered (#462).
 *
 * The values are asserted rather than the rendering: what went wrong was a
 * colour too close to another colour, and a test that only checked "a class is
 * applied" would have passed against the version that caused the report.
 */
const SRC = join(import.meta.dir, "..", "..");

function read(rel: string): string {
	return readFileSync(join(SRC, rel), "utf8");
}

/** The `--color-conv-*` values from one of `index.css`'s two theme blocks. */
function palette(theme: "dark" | "light"): Record<string, string> {
	const css = read("index.css");
	// Dark is bare `:root`; light is the `[data-theme="light"]` block after it.
	const start = theme === "dark" ? 0 : css.indexOf('[data-theme="light"]');
	const block = css.slice(start, css.indexOf("}", start));
	const out: Record<string, string> = {};
	for (const [, name, value] of block.matchAll(/--color-conv-([\w-]+):\s*(#[0-9a-f]{6})/g)) {
		out[name] = value;
	}
	return out;
}

function rgb(hex: string): [number, number, number] {
	return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

/** Largest per-channel difference. The complaint was 9/255 on every channel. */
function apart(a: string, b: string): number {
	const [x, y] = [rgb(a), rgb(b)];
	return Math.max(...x.map((v, i) => Math.abs(v - y[i])));
}

describe("the steward's own voice", () => {
	test.each(["dark", "light"] as const)("%s: has a surface of its own", (theme) => {
		const p = palette(theme);
		expect(p.steward).toBeTruthy();
		expect(p["steward-edge"]).toBeTruthy();
		expect(p.steward).not.toBe(p.surface);
		expect(p.steward).not.toBe(p.bubble);
	});

	// The number the report was about. `surface` against `bg` is 9; anything in
	// that neighbourhood is a bubble nobody sees.
	test.each(["dark", "light"] as const)("%s: stands off the page it is drawn on", (theme) => {
		const p = palette(theme);
		expect(apart(p.steward, p.bg)).toBeGreaterThanOrEqual(24);
		expect(apart(p.steward, p.surface)).toBeGreaterThanOrEqual(20);
	});

	// Colour alone fails a reader who cannot separate two warm neutrals, and the
	// two themes must not disagree about which speaker is which.
	test("carries an edge as well as a colour, in one place both screens read", () => {
		const view = read("components/steward/StewardView.tsx");
		expect(view).toContain("export function speakerSurface");
		expect(view).toContain("bg-cv-steward");
		expect(view).toContain("border-l-");
		expect(read("components/chat/StewardSessionView.tsx")).toContain("speakerSurface(turn.role)");
	});

	// An agent-derived turn is a session event, not the steward addressing
	// anyone, so it keeps the quiet surface. Sharing one colour is half of what
	// made the steward's own words unfindable.
	test("an agent turn is not dressed as the steward", () => {
		const fn = read("components/steward/StewardView.tsx");
		const body = fn.slice(fn.indexOf("export function speakerSurface"));
		expect(body.slice(0, 400)).toContain('return "bg-cv-surface"');
	});

	test("both themes define every token the classes name", () => {
		const css = read("index.css");
		for (const token of ["--color-cv-steward:", "--color-cv-steward-edge:"]) {
			expect(css).toContain(token);
		}
		for (const theme of ["dark", "light"] as const) {
			expect(palette(theme).steward).toMatch(/^#[0-9a-f]{6}$/);
			expect(palette(theme)["steward-edge"]).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});
