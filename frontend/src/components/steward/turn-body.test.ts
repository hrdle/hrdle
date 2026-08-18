import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a turn shows, and when it was said.
 *
 * The steward writes twice - a page-sized `text` for the glasses and a `detail`
 * with the code and the reasoning - and the phone rendered the second half as a
 * collapsed `詳細` row under every message. Five consecutive replies, five
 * disclosure triangles, each of which had to be opened to find out whether it
 * held anything: the shape of an AI chat rather than of a conversation, and
 * rejected on sight.
 *
 * The split is the *glasses'* constraint. It has no business following the
 * message onto a screen that can hold it.
 */
const SRC = join(import.meta.dir, "..", "..");

function read(rel: string): string {
	return readFileSync(join(SRC, rel), "utf8");
}

const SCREENS = ["components/steward/StewardView.tsx", "components/chat/StewardSessionView.tsx"];

describe("a turn is one message", () => {
	test("there is no expander left to open", () => {
		expect(existsSync(join(SRC, "components/steward/TurnDetail.tsx"))).toBe(false);
		for (const screen of SCREENS) {
			expect(read(screen)).not.toContain("TurnDetail");
		}
	});

	// The server *moves* an over-long `text` down into `detail`, so the two are
	// often one sentence cut in the middle. Dropping the second half to be rid
	// of the toggle would lose what the message was saying.
	test("the detail is still shown - inline, as part of the message", () => {
		const body = read("components/steward/TurnBody.tsx");
		expect(body).toContain("detail");
		expect(body).toContain("Markdown");
		expect(body).not.toContain("useState");
		for (const screen of SCREENS) {
			expect(read(screen)).toContain("<TurnBody");
			expect(read(screen)).toMatch(/detail=\{(item|turn)\.detail\}/);
		}
	});

	test("its strings go with it", () => {
		for (const locale of ["en", "ja"]) {
			const table = JSON.parse(read(`i18n/locales/${locale}.json`)) as {
				steward: Record<string, string>;
			};
			expect(table.steward.detailShow).toBeUndefined();
			expect(table.steward.detailHide).toBeUndefined();
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
