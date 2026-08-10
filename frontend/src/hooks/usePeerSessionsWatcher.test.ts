import { describe, expect, it } from "bun:test";
import { LOCAL_PEER_ID, type PeerClientView } from "../../../shared/types";
import { peersWatcherKey, shouldDial } from "./usePeerSessionsWatcher";

function peer(over: Partial<PeerClientView> = {}): PeerClientView {
	return {
		id: "p_1",
		nickname: "Mac",
		url: "https://mac.example.ts.net:5924",
		color: "#8b5cf6",
		order: 1,
		status: "online",
		...over,
	};
}

describe("shouldDial", () => {
	it("dials a peer the poll reports as online", () => {
		expect(shouldDial(peer())).toBe(true);
	});

	it("does not dial a peer the poll reports as offline", () => {
		// Every attempt costs a full TCP timeout, and the peers poll already
		// knows the answer.
		expect(shouldDial(peer({ status: "offline" }))).toBe(false);
	});

	it("still dials on unknown, which is what a fresh poll looks like", () => {
		expect(shouldDial(peer({ status: "unknown" }))).toBe(true);
	});

	it("still dials on unauthorized, which fails fast instead of timing out", () => {
		expect(shouldDial(peer({ status: "unauthorized" }))).toBe(true);
	});

	it("always dials the local Hub, whatever status it carries", () => {
		// The local peer is this page's own origin; a stale status must not stop
		// the Hub's own session list from staying live.
		expect(shouldDial(peer({ id: LOCAL_PEER_ID, url: "self" }))).toBe(true);
		expect(
			shouldDial(peer({ id: LOCAL_PEER_ID, url: "self", status: "offline" })),
		).toBe(true);
	});
});

describe("peersWatcherKey", () => {
	it("changes when a peer goes offline, so reconcile re-runs", () => {
		// Without status in the key, a peer that went offline would keep being
		// dialled until some other field happened to change.
		const online = peersWatcherKey([peer()]);
		const offline = peersWatcherKey([peer({ status: "offline" })]);
		expect(online).not.toBe(offline);
	});

	it("changes again when the peer comes back, so the watcher reopens", () => {
		const before = peersWatcherKey([peer({ status: "offline" })]);
		const after = peersWatcherKey([peer({ status: "online" })]);
		expect(before).not.toBe(after);
	});

	it("ignores fields the watcher does not care about", () => {
		const a = peersWatcherKey([peer({ nickname: "Mac", color: "#000000" })]);
		const b = peersWatcherKey([peer({ nickname: "Laptop", color: "#ffffff" })]);
		expect(a).toBe(b);
	});

	it("is order-independent so a reordered poll does not re-run reconcile", () => {
		const a = peer({ id: "p_1" });
		const b = peer({ id: "p_2", url: "https://b.example.ts.net:5924" });
		expect(peersWatcherKey([a, b])).toBe(peersWatcherKey([b, a]));
	});
});
