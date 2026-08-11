import { describe, expect, test } from "bun:test";
import { makeSessionKey, parseSessionKey, sessionKeyOf } from "./sessionKey";

describe("makeSessionKey / parseSessionKey", () => {
	test("unset peer means local", () => {
		expect(makeSessionKey("hrdle")).toBe("local:hrdle");
		expect(makeSessionKey("hrdle", undefined)).toBe("local:hrdle");
		expect(makeSessionKey("hrdle", null)).toBe("local:hrdle");
	});

	test("remote peer round-trips", () => {
		const key = makeSessionKey("hrdle", "p_ab12cd34");
		expect(key).toBe("p_ab12cd34:hrdle");
		expect(parseSessionKey(key)).toEqual({ peerId: "p_ab12cd34", id: "hrdle" });
	});

	test("id containing ':' round-trips (only the peer prefix is split off)", () => {
		const key = makeSessionKey("feat:branch", "p_12ab34cd");
		expect(parseSessionKey(key)).toEqual({
			peerId: "p_12ab34cd",
			id: "feat:branch",
		});
		expect(parseSessionKey("local:a:b")).toEqual({ peerId: "local", id: "a:b" });
	});

	test("legacy bare id parses as local", () => {
		expect(parseSessionKey("my-workspace")).toEqual({
			peerId: "local",
			id: "my-workspace",
		});
	});

	test("bare id with a non-peer-shaped ':' prefix stays intact", () => {
		expect(parseSessionKey("feat:branch")).toEqual({
			peerId: "local",
			id: "feat:branch",
		});
	});

	test("sessionKeyOf reads the (id, peerId) tuple", () => {
		expect(sessionKeyOf({ id: "hrdle" })).toBe("local:hrdle");
		expect(sessionKeyOf({ id: "hrdle", peerId: "p_ab12cd34" })).toBe(
			"p_ab12cd34:hrdle",
		);
	});
});
