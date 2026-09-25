import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How big the chat's text is.
 *
 * The size itself is a number in localStorage and is not worth a test. What is
 * worth pinning is the wiring around it, because every part of it was a real
 * defect before: the setting existed on one screen and not the one being read,
 * the key it is kept under decides whether anyone's existing preference
 * survives, and two screens showing the same setting have to agree.
 */
const SRC = join(import.meta.dir, "..");

function read(rel: string): string {
	return readFileSync(join(SRC, rel), "utf8");
}

describe("the chat's font size", () => {
	// A new key would silently reset the size for whoever had already set one,
	// and leave the old value behind to be read by nothing.
	test("keeps the key the conversation viewer already used", () => {
		expect(read("hooks/useChatFontSize.ts")).toContain(
			'storageKey("conversation-font-size")',
		);
	});

	// Secondary text trails the body rather than tracking it: at 24px a caption
	// scaled proportionally is as loud as the message it belongs to.
	test("captions read through their own variable", () => {
		expect(read("hooks/useChatFontSize.ts")).toContain("--cv-fs-meta");
	});

	// The dashboard's control and an open chat are two mounts of the same
	// setting, and a change in one has to reach the other - the phone's
	// dashboard is a full screen, so the chat behind it is a different mount.
	test("a change in one screen reaches the others", () => {
		const hook = read("hooks/useChatFontSize.ts");
		expect(hook).toContain("hrdle-chat-font-size");
		expect(hook).toContain("dispatchEvent");
		expect(hook).toContain("addEventListener");
	});

	test("the control is reachable without a gesture", () => {
		const dashboard = read("components/dashboard/Dashboard.tsx");
		expect(dashboard).toContain("useChatFontSize");
		expect(dashboard).toContain("appearance.chatFontSize");
	});

	test("both locales carry the strings", () => {
		for (const locale of ["en", "ja"]) {
			const table = JSON.parse(read(`i18n/locales/${locale}.json`)) as {
				appearance: Record<string, string>;
			};
			for (const key of [
				"chatFontSize",
				"chatFontSmaller",
				"chatFontLarger",
				"chatFontReset",
			]) {
				expect(table.appearance[key]).toBeTruthy();
			}
		}
	});
});
