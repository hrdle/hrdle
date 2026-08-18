import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Taking a picture rather than finding one.
 *
 * The composer could attach an image from the library, and going through the
 * library to photograph a screen or a printed part is three taps and a scroll
 * past everything else in it. Reported as something used often.
 *
 * The e2e specs cover a phone and a tablet. The desktop half is here because
 * the thread is not reachable from a desktop layout the way it is on a phone -
 * its entry point is in the session list's own screen.
 */
const SRC = join(import.meta.dir, "..", "..");
const composer = readFileSync(join(SRC, "components/steward/StewardSessionComposer.tsx"), "utf8");

describe("the camera button", () => {
	// `capture` is an attribute of the element the picker was opened from, so
	// toggling it on the existing input before a click races the host's sheet.
	test("has an input of its own", () => {
		expect(composer).toContain('capture="environment"');
		expect(composer).toContain("cameraRef");
		expect(composer.match(/type="file"/g)?.length).toBe(2);
	});

	// It is ignored rather than refused on a desktop browser, so without the
	// gate the button is there and opens the same picker as the one beside it -
	// two identical controls with different icons.
	test("is drawn only where a camera is", () => {
		expect(composer).toContain('matchMedia("(pointer: coarse)")');
		expect(composer).toContain("{hasCamera && (");
	});

	test("both locales name it", () => {
		for (const locale of ["en", "ja"]) {
			const table = JSON.parse(readFileSync(join(SRC, `i18n/locales/${locale}.json`), "utf8")) as {
				steward: Record<string, string>;
			};
			expect(table.steward.takePhoto).toBeTruthy();
		}
	});
});
