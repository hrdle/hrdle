import { describe, expect, it } from "bun:test";
import { expandPath, homeOf, pathCrumbs, promptPathFor } from "./file-places";

describe("pathCrumbs", () => {
	it("starts at ~ for a path under home", () => {
		expect(pathCrumbs("/home/u/repos/hrdle", "/home/u")).toEqual([
			{ label: "~", path: "/home/u", isHome: true },
			{ label: "repos", path: "/home/u/repos", isHome: false },
			{ label: "hrdle", path: "/home/u/repos/hrdle", isHome: false },
		]);
	});

	it("steps from the root for a path outside home", () => {
		expect(pathCrumbs("/tmp/x", "/home/u").map((c) => c.path)).toEqual([
			"/tmp",
			"/tmp/x",
		]);
	});

	it("does not take a sibling with the same prefix for home", () => {
		expect(pathCrumbs("/home/user2/a", "/home/u")[0]?.label).toBe("home");
	});
});

describe("homeOf", () => {
	it("reads Linux and macOS homes", () => {
		expect(homeOf("/home/u/repos")).toBe("/home/u");
		expect(homeOf("/Users/u/repos")).toBe("/Users/u");
		expect(homeOf("/tmp")).toBeNull();
	});
});

describe("expandPath", () => {
	it("expands ~, resolves .. and joins relative input", () => {
		expect(expandPath("~/repos", "/home/u", "/x")).toBe("/home/u/repos");
		expect(expandPath("../b/./c/", "/home/u", "/home/u/a")).toBe("/home/u/b/c");
		expect(expandPath("/etc/../tmp", "/home/u", "/x")).toBe("/tmp");
	});
});

describe("promptPathFor", () => {
	it("is relative inside the session and absolute outside it", () => {
		expect(promptPathFor("/home/u/p/src/a.ts", "/home/u/p")).toBe("@src/a.ts");
		expect(promptPathFor("/home/u/.zshrc", "/home/u/p")).toBe("@/home/u/.zshrc");
		expect(promptPathFor("/home/u/pp/a.ts", "/home/u/p")).toBe("@/home/u/pp/a.ts");
	});
});
