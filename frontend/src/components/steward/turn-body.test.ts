import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a turn shows, and when it was said.
 *
 * The steward writes twice - a page-sized `text` for the glasses and a `detail`
 * with the code and the reasoning - and the second half stays behind a tap.
 * It was inlined for a day on a misread of "this is an AI thing, I do not need
 * it", which was about the coloured rule down the card's edge; the disclosure
 * was never what anyone objected to.
 */
const SRC = join(import.meta.dir, "..", "..");

function read(rel: string): string {
	return readFileSync(join(SRC, rel), "utf8");
}

const SCREENS = ["components/steward/StewardView.tsx", "components/chat/StewardSessionView.tsx"];

describe("a turn's second half", () => {
	// Inlined for a day on a misread: "this is an AI thing, I do not need it"
	// was about the coloured rule down the card's edge, not about the
	// disclosure. Putting it back is the correction, not a second opinion about
	// which reads better.
	test("is behind its tap, on both screens", () => {
		for (const screen of SCREENS) {
			expect(read(screen)).toMatch(/<TurnDetail detail=\{(item|turn)\.detail\}/);
		}
		// The prose mentions it; the component does not take it.
		const body = read("components/steward/TurnBody.tsx");
		expect(body).toContain("export function TurnBody({ text }: { text: string })");
		expect(body).not.toContain("Markdown");
	});

	test("its strings are back in both locales", () => {
		for (const locale of ["en", "ja"]) {
			const table = JSON.parse(read(`i18n/locales/${locale}.json`)) as {
				steward: Record<string, string>;
			};
			expect(table.steward.detailShow).toBeTruthy();
			expect(table.steward.detailHide).toBeTruthy();
		}
	});
});

describe("when it was said", () => {
	test("every turn carries its time, on both screens", () => {
		for (const screen of SCREENS) {
			expect(read(screen)).toMatch(/<TurnTime at=\{(item|turn)\.at\}/);
		}
	});

	// A conversation is read as a sequence of moments, and the date in front of
	// every one of them is a column of the same nine characters.
	test("the date appears only once the turn is no longer today", () => {
		const body = read("components/steward/TurnBody.tsx");
		expect(body).toContain("toDateString()");
		expect(body).toContain('sameDay ? ""');
	});

	// At 24px a caption scaled with the body is as loud as the message.
	test("it trails the body rather than growing with it", () => {
		expect(read("components/steward/TurnBody.tsx")).toContain("--cv-fs-meta");
	});

	test("it is a real time element, not a styled string", () => {
		const body = read("components/steward/TurnBody.tsx");
		expect(body).toContain("<time");
		expect(body).toContain("dateTime=");
	});
});

/**
 * Which detail is already open.
 *
 * The newest reply's - what has just arrived is what someone came to read, and
 * asking them to tap it is asking them to tap the thing they are already
 * looking at. Everything older stays shut, which is the whole reason the
 * disclosure exists.
 */
describe("the newest reply", () => {
	test("is the last entry carrying a detail, not simply the last entry", async () => {
		const { newestWithDetail } = await import("./TurnDetail");
		expect(
			newestWithDetail([
				{ id: "a", detail: "one" },
				{ id: "b", detail: "two" },
				// A person's own message. With the plain rule, typing this would
				// shut the answer they were reading.
				{ id: "c" },
			]),
		).toBe("b");
	});

	test("is nothing when no entry has one", async () => {
		const { newestWithDetail } = await import("./TurnDetail");
		expect(newestWithDetail([{ id: "a" }, { id: "b", detail: "  " }])).toBeNull();
	});

	test("both screens ask for it, and only the newest gets it", () => {
		for (const screen of SCREENS) {
			const source = read(screen);
			expect(source).toContain("newestWithDetail");
			expect(source).toContain("startOpen={newest}");
			expect(source).toMatch(/newest=\{(item|turn)\.id === newestDetail\}/);
		}
	});

	// A new arrival makes this one no longer the newest, and `useState` alone
	// runs once - so the previous reply would stay open and the column would
	// fill up with them.
	test("shuts again when it stops being the newest", () => {
		const detail = read("components/steward/TurnDetail.tsx");
		expect(detail).toContain("useEffect");
		expect(detail).toContain("[startOpen]");
	});
});
