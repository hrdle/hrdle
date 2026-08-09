import { describe, expect, test } from "bun:test";
import { extractViewportUrls, viewportMayHaveUrl } from "./terminal-links";

// The Claude Code login screen as it actually reached a 120-column pane, read
// back with `herdr pane read --source visible` on 2026-08-09. This is the case
// the extractor exists for: `c to copy` cannot reach a browser's clipboard, so
// the URL has to be recoverable from the rendered rows.
const LOGIN_URL =
	"https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=SvCCvLmQlzAQHA245202qL8AKSjshBeEEWv728I405E&code_challenge_method=S256&state=cjWHQPvEnYGYS0q5o9VbT7T6rwzkqvyLTdzzBNaepSA";

function wrapAt(url: string, cols: number): string[] {
	const rows: string[] = [];
	for (let i = 0; i < url.length; i += cols) rows.push(url.slice(i, i + cols));
	return rows;
}

describe("extractViewportUrls", () => {
	test("rejoins the login URL Claude Code split across four rows", () => {
		const rows = wrapAt(LOGIN_URL, 120);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toHaveLength(120);
		const lines = [
			"   Login",
			"",
			"   Browser didn't open? Use the url below to sign in (c to copy)",
			"",
			...rows,
			"",
			"   Paste code here if prompted >",
			"",
			"   Esc to cancel",
		];
		expect(extractViewportUrls(lines, 120)).toEqual([LOGIN_URL]);
	});

	test("rejoins rows that still carry herdr's trailing CR", () => {
		// What a live pane actually delivers: `pane.read` returns CRLF rows and
		// the capture splits on `\n`, so a full row measures cols + 1.
		const rows = wrapAt(LOGIN_URL, 120).map((r) => `${r}\r`);
		expect(extractViewportUrls(rows, 120)).toEqual([LOGIN_URL]);
	});

	test("a continuation row is not also reported as a URL of its own", () => {
		// The second row of the login URL contains `https%3A%2F%2Fplatform...`,
		// which is not a scheme — but a row could carry a real one.
		const lines = [`${"a".repeat(112)}http://x.io/`, "http://inner.example/y"];
		expect(extractViewportUrls(lines, 124)).toEqual([
			"http://x.io/http://inner.example/y",
		]);
	});

	test("does not glue a URL that merely ends a short row to the row below", () => {
		const lines = ["see http://example.com", "foo=bar"];
		expect(extractViewportUrls(lines, 120)).toEqual(["http://example.com"]);
	});

	test("stops the join at the first row that does not fill the pane", () => {
		const lines = ["http://a.test/".padEnd(20, "z"), "tail", "more"];
		expect(extractViewportUrls(lines, 20)).toEqual([
			`${"http://a.test/".padEnd(20, "z")}tail`,
		]);
	});

	test("stops a continuation at a box border, which is not a URL character", () => {
		const row = `http://a.test/${"z".repeat(6)}`;
		expect(row).toHaveLength(20);
		expect(extractViewportUrls([row, "│ next pane content"], 20)).toEqual([row]);
	});

	test("reads through SGR colouring, which every real row carries", () => {
		const lines = ["\x1b[0;36mhttps://example.com/path\x1b[0m"];
		expect(extractViewportUrls(lines, 120)).toEqual([
			"https://example.com/path",
		]);
	});

	test("leaves prose punctuation and unopened brackets out of the URL", () => {
		expect(extractViewportUrls(["Visit https://example.com/a."], 120)).toEqual([
			"https://example.com/a",
		]);
		expect(extractViewportUrls(["(see https://example.com/b)"], 120)).toEqual([
			"https://example.com/b",
		]);
		expect(
			extractViewportUrls(["https://example.com/x?a=(1)"], 120),
		).toEqual(["https://example.com/x?a=(1)"]);
	});

	test("a full row of wide characters is full at half the character count", () => {
		// 10 CJK characters fill a 20-column row, so the URL after them still
		// continues below. Counting characters would have called the row short.
		const lines = [`${"日".repeat(3)}http://a.test/1`, "234", "x"];
		expect(extractViewportUrls(lines, 21)).toEqual(["http://a.test/1234"]);
	});

	test("keeps screen order and drops duplicates", () => {
		const lines = [
			"https://one.example/",
			"https://two.example/",
			"https://one.example/",
		];
		expect(extractViewportUrls(lines, 120)).toEqual([
			"https://one.example/",
			"https://two.example/",
		]);
	});

	test("caps the count, since a log full of URLs is not a link list", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `https://n${i}.example/`);
		expect(extractViewportUrls(lines, 120, 3)).toHaveLength(3);
	});

	test("returns nothing for a screen with no URL, and for a bare scheme", () => {
		expect(extractViewportUrls(["$ ls -la", "total 0"], 80)).toEqual([]);
		expect(extractViewportUrls(["https://"], 80)).toEqual([]);
	});
});

describe("viewportMayHaveUrl", () => {
	test("is the cheap gate the per-frame path runs first", () => {
		expect(viewportMayHaveUrl(["nothing here", "$ echo hi"])).toBe(false);
		expect(viewportMayHaveUrl(["nothing here", "go to http://x.test"])).toBe(
			true,
		);
	});
});
