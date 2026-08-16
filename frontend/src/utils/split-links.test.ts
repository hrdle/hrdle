import { describe, expect, test } from "bun:test";
import { splitLinks } from "./terminal-links";

describe("splitLinks", () => {
	test("prose with no link is one piece", () => {
		expect(splitLinks("テストが3件落ちています")).toEqual([{ text: "テストが3件落ちています" }]);
	});

	test("keeps the prose either side", () => {
		expect(splitLinks("詳細は https://example.com/a を見てください")).toEqual([
			{ text: "詳細は " },
			{ url: "https://example.com/a" },
			{ text: " を見てください" },
		]);
	});

	test("a sentence's full stop is not part of the URL", () => {
		expect(splitLinks("https://example.com/a. 以上")).toEqual([
			{ url: "https://example.com/a" },
			{ text: ". 以上" },
		]);
	});

	test("a link written straight against Japanese ends where the Japanese starts", () => {
		expect(splitLinks("https://example.com/aを見て")).toEqual([
			{ url: "https://example.com/a" },
			{ text: "を見て" },
		]);
	});

	test("two links in one message", () => {
		const parts = splitLinks("https://a.example/1 と https://b.example/2");
		expect(parts.filter((p) => "url" in p)).toEqual([
			{ url: "https://a.example/1" },
			{ url: "https://b.example/2" },
		]);
	});

	test("a bare scheme is not a link", () => {
		expect(splitLinks("https:// と書いただけ")).toEqual([{ text: "https:// と書いただけ" }]);
	});

	test("a query string survives", () => {
		expect(splitLinks("https://example.com/x?a=1&b=2#top")).toEqual([
			{ url: "https://example.com/x?a=1&b=2#top" },
		]);
	});
});
