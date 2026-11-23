import { describe, expect, test } from "bun:test";
import { pushInputHistory } from "./input-history";

describe("pushInputHistory", () => {
	test("puts the sent text first and drops its older copy", () => {
		expect(pushInputHistory(["b", "a", "c"], "a")).toEqual(["a", "b", "c"]);
	});

	test("keeps the 50 most recent", () => {
		const long = Array.from({ length: 50 }, (_, i) => `p${i}`);
		const next = pushInputHistory(long, "new");
		expect(next).toHaveLength(50);
		expect(next[0]).toBe("new");
		expect(next).not.toContain("p49");
	});

	test("does not change the list it was given", () => {
		const before = ["a", "b"];
		pushInputHistory(before, "c");
		expect(before).toEqual(["a", "b"]);
	});
});
