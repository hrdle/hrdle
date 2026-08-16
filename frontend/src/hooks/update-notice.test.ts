import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How a page learns it is old.
 *
 * The service worker's own schedule is visibility changes and a half-hourly
 * timer, so a phone left open on one screen missed a release for up to half an
 * hour - and the fix that had just shipped read as a fix that had not worked.
 * The server's version now rides on `sessions-updated`, which already arrives
 * every five seconds.
 *
 * Pinned as wiring rather than behaviour: the parts are a service worker, a
 * WebSocket and a build-time constant, and a test that mocked all three would
 * assert its own mocks.
 */
const SRC = join(import.meta.dir, "..");

describe("the update notice", () => {
	test("the server puts its version on the push that already arrives", () => {
		const mux = readFileSync(join(SRC, "../../backend/src/routes/terminal-mux.ts"), "utf8");
		const payload = mux.slice(mux.indexOf("function sessionsUpdatedPayload"));
		expect(payload.slice(0, 600)).toContain("version: VERSION");
	});

	test("a mismatch makes the worker look, rather than claiming an update", () => {
		const mod = readFileSync(join(SRC, "services/build-version.ts"), "utf8");
		expect(mod).toContain("export function noteServerVersion");
		expect(mod).toContain("__APP_VERSION__");
		// Not `updateDetected = true`: the prompt's reload needs a worker that has
		// actually precached the new build, and there is none yet.
		expect(mod).not.toContain("updateDetected");
		expect(mod).toContain("checkNow");
		// And no service-worker import, or every unit test touching a caller dies
		// on `virtual:pwa-register`. The comment naming it is the point, so this
		// looks at the imports.
		expect(mod).not.toMatch(/^import .*virtual:pwa-register/m);
	});

	test("both sockets that carry the push report it", () => {
		for (const file of ["services/steward-socket.ts", "hooks/usePeerSessionsWatcher.ts"]) {
			expect(readFileSync(join(SRC, file), "utf8")).toContain("noteServerVersion");
		}
	});
});
