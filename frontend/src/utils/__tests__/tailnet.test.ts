import { describe, expect, test } from "bun:test";
import { isTailnetHost } from "../tailnet";

/**
 * The point of the check is what it says to the user: a tailnet host earns
 * "turn Tailscale on", anything else gets the generic advice. So the cases
 * that matter are the ones that would put the wrong sentence on screen -
 * a LAN address mistaken for CGNAT, or a real tailnet address missed.
 */
describe("isTailnetHost", () => {
	test("recognises MagicDNS names", () => {
		expect(isTailnetHost("beelink-arch.tail4459c9.ts.net")).toBe(true);
		expect(isTailnetHost("BEELINK-ARCH.TAIL4459C9.TS.NET")).toBe(true);
	});

	test("recognises the CGNAT range and nothing next to it", () => {
		expect(isTailnetHost("100.91.210.90")).toBe(true);
		expect(isTailnetHost("100.64.0.1")).toBe(true);
		expect(isTailnetHost("100.127.255.255")).toBe(true);
		// 100.x outside 64-127 is ordinary public space, not Tailscale
		expect(isTailnetHost("100.63.0.1")).toBe(false);
		expect(isTailnetHost("100.128.0.1")).toBe(false);
	});

	test("recognises the Tailscale ULA prefix", () => {
		expect(isTailnetHost("fd7a:115c:a1e0::1")).toBe(true);
		expect(isTailnetHost("[fd7a:115c:a1e0:ab12::1]")).toBe(true);
		expect(isTailnetHost("fd00:115c:a1e0::1")).toBe(false);
	});

	test("leaves everything else to the generic advice", () => {
		expect(isTailnetHost("localhost")).toBe(false);
		expect(isTailnetHost("192.168.1.20")).toBe(false);
		expect(isTailnetHost("127.0.0.1")).toBe(false);
		expect(isTailnetHost("hrdle.example.com")).toBe(false);
		expect(isTailnetHost("")).toBe(false);
		// Not an address at all - must not be read as 100.64.x
		expect(isTailnetHost("100.64.0.999")).toBe(false);
	});
});
