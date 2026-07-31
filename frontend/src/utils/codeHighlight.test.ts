import { describe, expect, test } from "bun:test";
import {
	highlightToHtml,
	languageForOutput,
	languageForPath,
	languageFromClassName,
} from "./codeHighlight";

describe("languageForPath", () => {
	test("reads the extension a tool call was pointed at", () => {
		expect(languageForPath("/repos/app/src/index.tsx")).toBe("typescript");
		expect(languageForPath("scripts/build.sh")).toBe("bash");
		expect(languageForPath("config.toml")).toBe("ini");
	});

	test("knows files whose whole name is the type", () => {
		expect(languageForPath("/srv/app/Dockerfile")).toBe("dockerfile");
		expect(languageForPath("Makefile")).toBe("makefile");
	});

	test("no extension, no guess", () => {
		expect(languageForPath("/usr/bin/hrdle")).toBeNull();
		expect(languageForPath("notes.unknownext")).toBeNull();
		expect(languageForPath(undefined)).toBeNull();
		expect(languageForPath("")).toBeNull();
	});
});

describe("languageFromClassName", () => {
	test("reads the fence's language", () => {
		expect(languageFromClassName("language-ts")).toBe("typescript");
		expect(languageFromClassName("language-python")).toBe("python");
	});

	test("an unfenced inline code element names nothing", () => {
		expect(languageFromClassName(undefined)).toBeNull();
		expect(languageFromClassName("some-other-class")).toBeNull();
	});
});

describe("highlightToHtml", () => {
	test("marks up a known language", () => {
		const html = highlightToHtml("const x = 1;", "typescript");
		expect(html).toContain("hljs-keyword");
		expect(html).toContain("const");
	});

	test("declines rather than returning the source untouched", () => {
		// The result goes through dangerouslySetInnerHTML, so "no highlight"
		// must never mean "here is the raw text".
		expect(highlightToHtml("<script>alert(1)</script>", null)).toBeNull();
		expect(highlightToHtml("<script>alert(1)</script>", "not-a-language")).toBeNull();
		expect(highlightToHtml("", "typescript")).toBeNull();
	});

	test("escapes what it does mark up", () => {
		const html = highlightToHtml('const s = "<script>";', "typescript");
		expect(html).not.toBeNull();
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("a file-sized blob is left alone", () => {
		expect(highlightToHtml("x".repeat(40_001), "typescript")).toBeNull();
	});
});

describe("languageForOutput", () => {
	test("file content gets the language of the file it came from", () => {
		expect(languageForOutput("src/index.ts", "const a = 1;\nconst b = 2;")).toBe(
			"typescript",
		);
	});

	test("a one-line status message is a sentence, not source", () => {
		// "File created successfully at: /home/..." was being tinted as TypeScript.
		expect(
			languageForOutput("src/index.ts", "File created successfully at: /x/y.ts"),
		).toBeNull();
	});

	test("no path, no language", () => {
		expect(languageForOutput(undefined, "line\nline")).toBeNull();
	});
});
