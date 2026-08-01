import { describe, expect, test } from "bun:test";
import { getToolSummary } from "./toolSummary";

describe("getToolSummary", () => {
	test("an author's own description wins", () => {
		expect(
			getToolSummary({ description: "Run the tests", command: "bun test" }),
		).toBe("Run the tests");
	});

	test("file tools show the basename, not the path that pushes it off screen", () => {
		expect(getToolSummary({ file_path: "/home/m0a/repos/app/src/index.ts" })).toBe(
			"index.ts",
		);
		expect(getToolSummary({ notebook_path: "/tmp/a/b/run.ipynb" })).toBe(
			"run.ipynb",
		);
	});

	test("search tools show their query — the row that used to say only WebSearch", () => {
		expect(
			getToolSummary({ query: "XIAO ESP32S3 Sense SD card SPI pins" }),
		).toBe("XIAO ESP32S3 Sense SD card SPI pins");
		expect(getToolSummary({ query: "select:WebFetch", max_results: 1 })).toBe(
			"select:WebFetch",
		);
	});

	test("a pattern outranks a query when a tool carries both", () => {
		expect(getToolSummary({ pattern: "TODO", query: "unused" })).toBe("TODO");
	});

	test("a scoped search shows what it looked for, not where it looked", () => {
		// Grep carries a `path` as well whenever it is scoped, and reading that
		// first named the directory instead of the search.
		expect(
			getToolSummary({ pattern: "getToolSummary", path: "frontend/src" }),
		).toBe("getToolSummary");
	});

	test("Kimi names the file argument `path`, and the row has to read it", () => {
		expect(getToolSummary({ path: "HANDOFF.md", line_offset: 0 })).toBe(
			"HANDOFF.md",
		);
	});

	test("a fetch shows its address rather than the question asked of it", () => {
		expect(
			getToolSummary({ url: "https://example.com/spec", prompt: "What pins?" }),
		).toBe("https://example.com/spec");
	});

	test("a command is cut to its first line", () => {
		expect(getToolSummary({ command: "cd /tmp\nls -la\necho done" })).toBe(
			"cd /tmp",
		);
	});

	test("long text is ellipsized so the header cannot be pushed apart", () => {
		const summary = getToolSummary({ prompt: "x".repeat(200) });
		expect(summary.length).toBe(61);
		expect(summary.endsWith("…")).toBe(true);
	});

	test("an unrecognised tool falls back to its first short string", () => {
		expect(getToolSummary({ owner: "hrdle", repo: "hrdle" })).toBe("hrdle");
	});

	test("identifiers and knobs are not worth showing", () => {
		expect(getToolSummary({ session_id: "abcd-1234", model: "opus" })).toBe("");
		expect(getToolSummary({ id: "x1", title: "Rename the pane" })).toBe(
			"Rename the pane",
		);
	});

	test("a wall of text is not a summary", () => {
		expect(getToolSummary({ content: "line\nline\nline" })).toBe("");
		expect(getToolSummary({ content: "y".repeat(200) })).toBe("");
	});

	test("nothing to say stays empty rather than inventing something", () => {
		expect(getToolSummary({})).toBe("");
		expect(getToolSummary({ todos: [{ content: "a" }] })).toBe("");
	});
});
