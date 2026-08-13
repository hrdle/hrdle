import { describe, expect, test } from "bun:test";
import { shouldFollowSessionDir } from "./file-viewer-follow";

describe("shouldFollowSessionDir", () => {
	const open = (...dirs: string[]) => new Set(dirs);

	test("follows the new session when the panel is open on another directory", () => {
		expect(shouldFollowSessionDir("/repo", "/tmp", open("/tmp"))).toBe(true);
	});

	test("stays put when the panel is already on that directory", () => {
		expect(shouldFollowSessionDir("/tmp", "/tmp", open("/tmp"))).toBe(false);
	});

	test("does not open a panel that was dismissed", () => {
		expect(shouldFollowSessionDir("/repo", "/tmp", open())).toBe(false);
	});

	test("does not open a panel that was never opened", () => {
		expect(shouldFollowSessionDir("/repo", null, open())).toBe(false);
	});

	test("does nothing when the session has no directory yet", () => {
		expect(shouldFollowSessionDir(undefined, "/tmp", open("/tmp"))).toBe(false);
	});
});
