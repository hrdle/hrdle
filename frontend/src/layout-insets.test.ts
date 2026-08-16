import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * The top escape (status bar / Dynamic Island) is held by `#root` in
 * index.css and nowhere else. This guard exists because the other way was
 * tried three times: padding added screen by screen, and each round left a
 * different screen under the bar (list, then dashboard, then terminal, then
 * the file browser). A full-screen overlay (position: fixed) does not take
 * content padding at all, so some screens cannot be fixed that way.
 *
 * When the next person notices one screen sitting under the bar, this points
 * them at `#root` instead of the addition that never finishes.
 */

const SRC_DIR = import.meta.dir;
const ROOT_CSS = join(SRC_DIR, "index.css");
const TOP_INSET = "safe-area-inset-top";

function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sourceFiles(path));
		else if (/\.(ts|tsx|css)$/.test(entry.name)) found.push(path);
	}
	return found;
}

test("the top escape lives inside #root in index.css", () => {
	// Twice inside the rule (moving down, and shortening by the same amount),
	// so this reads which rule holds it rather than counting occurrences.
	const css = readFileSync(ROOT_CSS, "utf8");
	const start = css.indexOf("#root {");
	const end = css.indexOf("}", start);
	expect(css.slice(start, end)).toContain(TOP_INSET);
	expect(css.slice(0, start) + css.slice(end)).not.toContain(TOP_INSET);
});

/**
 * The bottom edge is the same story with a different mechanism, and it cost a
 * release: `--vh` is the *visual* viewport's height, so `#root` is already
 * exactly the area above the soft keyboard, and its transform is what a
 * `position: fixed` child is positioned against. A component that measured the
 * keyboard and moved its own bar up therefore subtracted it twice and parked
 * the bar over the header (0.3.148, measured on an Android phone).
 *
 * This pins the mechanism rather than every misuse of it: if `--vh` stops
 * being the visual viewport, per-screen compensation becomes necessary again
 * and whoever changes it should find out here.
 */
test("the soft keyboard is handled once, by --vh", () => {
	const main = readFileSync(join(SRC_DIR, "main.tsx"), "utf8");
	expect(main).toContain("visualViewport");
	expect(main).toMatch(/--vh["'],\s*`\$\{vh\}px`/);
	expect(main).toMatch(/const vh = vv\?\.height/);

	const css = readFileSync(ROOT_CSS, "utf8");
	const start = css.indexOf("#root {");
	expect(css.slice(start, css.indexOf("}", start))).toContain("var(--vh");
});

test("no other file escapes the top edge on its own", () => {
	const offenders = sourceFiles(SRC_DIR)
		.filter((path) => path !== ROOT_CSS && path !== import.meta.path)
		.filter((path) => readFileSync(path, "utf8").includes(TOP_INSET))
		.map((path) => path.slice(SRC_DIR.length + 1));

	expect(offenders).toEqual([]);
});
