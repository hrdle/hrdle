import { describe, expect, test } from "bun:test";
import { shouldOfferLinkMenu } from "./link-menu";

describe("shouldOfferLinkMenu", () => {
	test("an installed app asks what to do with a web link", () => {
		expect(shouldOfferLinkMenu(true, "https://example.com/a")).toBe(true);
		expect(shouldOfferLinkMenu(true, "http://example.com/a")).toBe(true);
	});

	test("a browser tab keeps the ordinary link", () => {
		expect(shouldOfferLinkMenu(false, "https://example.com/a")).toBe(false);
	});

	test("links that are not web pages are left alone", () => {
		expect(shouldOfferLinkMenu(true, "mailto:someone@example.com")).toBe(false);
		expect(shouldOfferLinkMenu(true, "tel:0123")).toBe(false);
	});
});
