import { describe, expect, test } from "bun:test";
import { needsIntentEscape, toIntentUrl } from "./external-link";

const ANDROID =
	"Mozilla/5.0 (Linux; Android 16; Pixel) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36";
const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36";

describe("needsIntentEscape", () => {
	test("an installed Android PWA needs it", () => {
		expect(needsIntentEscape(ANDROID, true, "https://example.com/a")).toBe(true);
	});

	test("a browser tab does not - the ordinary link is already right", () => {
		expect(needsIntentEscape(ANDROID, false, "https://example.com/a")).toBe(false);
	});

	test("iOS does not: intent:// does nothing there", () => {
		expect(needsIntentEscape(IPHONE, true, "https://example.com/a")).toBe(false);
	});

	test("desktop does not", () => {
		expect(needsIntentEscape(DESKTOP, true, "https://example.com/a")).toBe(false);
	});

	test("only http(s) - anything else is not ours to redirect", () => {
		expect(needsIntentEscape(ANDROID, true, "mailto:a@example.com")).toBe(false);
	});
});

describe("toIntentUrl", () => {
	test("the scheme moves into the fragment, and the original is the fallback", () => {
		expect(toIntentUrl("https://github.com/hrdle/hrdle/pull/450")).toBe(
			"intent://github.com/hrdle/hrdle/pull/450#Intent;scheme=https;package=com.android.chrome;" +
				"action=android.intent.action.VIEW;" +
				`S.browser_fallback_url=${encodeURIComponent("https://github.com/hrdle/hrdle/pull/450")};end`,
		);
	});

	// Measured: without it the intent came straight back to the app it was
	// dispatched from, and the link opened inside the PWA again.
	test("the browser is named, or the app it came from claims it back", () => {
		expect(toIntentUrl("https://example.com/a")).toContain("package=com.android.chrome");
	});

	test("a query and a fragment survive into the fallback", () => {
		const url = "https://example.com/x?a=1&b=2#top";
		const intent = toIntentUrl(url);
		expect(intent.startsWith("intent://example.com/x?a=1&b=2#top#Intent;")).toBe(true);
		expect(intent).toContain(`S.browser_fallback_url=${encodeURIComponent(url)}`);
	});
});
