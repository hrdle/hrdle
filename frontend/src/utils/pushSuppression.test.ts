/**
 * One hook event, two ways to this device: the page's mux broadcast and the
 * server's Web Push. Where both are live they are the same notification (#331),
 * and the page is the side that yields.
 *
 * Both halves are exercised together on purpose, through the real
 * `ensurePushSubscription` rather than a stubbed flag: what is being asserted is
 * that the page goes quiet *only* for a subscription the server accepted, and a
 * mocked flag would assert nothing about when it is raised.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { LOCAL_PEER_ID } from "../../../shared/types";

const fired: Array<{ title: string; options: NotificationOptions }> = [];

class FakeNotification {
	static permission = "granted";
	onclick: (() => void) | null = null;
	constructor(title: string, options: NotificationOptions) {
		fired.push({ title, options });
	}
	close() {}
}

const registration = {
	pushManager: {
		getSubscription: async () => null,
		subscribe: async () => ({
			toJSON: () => ({
				endpoint: "https://push.example/abc",
				keys: { p256dh: "p", auth: "a" },
			}),
		}),
	},
};

function defineGlobal(name: string, value: unknown) {
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** Whether `POST /api/push/subscribe` is answered ok. */
let subscribeAccepted = true;
/** Whether the server offers a VAPID key at all. */
let serverHasKey = true;

// bun test has no DOM, so every browser surface both modules touch is supplied.
defineGlobal("window", globalThis);
defineGlobal("PushManager", class {});
defineGlobal("Notification", FakeNotification);
defineGlobal("localStorage", { getItem: () => null });
defineGlobal("navigator", {
	userAgent: "test-agent",
	// `ready` is what subscribing needs. `getRegistration` is deliberately absent,
	// so `showNotification` falls through to the `Notification` constructor —
	// which is the path `fired` records.
	serviceWorker: { ready: Promise.resolve(registration) },
});
defineGlobal("fetch", async (input: string) => {
	if (input === "/api/push/key") {
		return serverHasKey
			? new Response(JSON.stringify({ publicKey: "dGVzdC1rZXk" }))
			: new Response("no key", { status: 404 });
	}
	if (input === "/api/push/subscribe") {
		return new Response("{}", { status: subscribeAccepted ? 200 : 500 });
	}
	throw new Error(`unexpected fetch: ${input}`);
});

const { ensurePushSubscription, isPushActive } = await import("./webPush");
const { fireHookNotification } = await import("./hookNotification");

/** The debounce keys on event + cwd, so each case brings its own pair. */
let n = 0;
function uniqueCwd() {
	n += 1;
	return `/home/someone/project-${n}`;
}

/** Put this browser on the server's push list, the way a page load does. */
async function subscribe() {
	subscribeAccepted = true;
	serverHasKey = true;
	expect(await ensurePushSubscription()).toBe("subscribed");
}

describe("isPushActive", () => {
	beforeEach(() => {
		subscribeAccepted = true;
		serverHasKey = true;
		FakeNotification.permission = "granted";
	});

	test("goes up only once the server accepted the subscription", async () => {
		await subscribe();
		expect(isPushActive()).toBe(true);
	});

	test("comes back down when the server refuses the subscription", async () => {
		await subscribe();
		subscribeAccepted = false;
		expect(await ensurePushSubscription()).toBe("failed");
		expect(isPushActive()).toBe(false);
	});

	test("comes back down when the server has no key to subscribe against", async () => {
		await subscribe();
		serverHasKey = false;
		expect(await ensurePushSubscription()).toBe("no-server-key");
		expect(isPushActive()).toBe(false);
	});

	test("comes back down when notification permission is gone", async () => {
		await subscribe();
		FakeNotification.permission = "denied";
		expect(await ensurePushSubscription()).toBe("no-permission");
		expect(isPushActive()).toBe(false);
	});
});

describe("fireHookNotification", () => {
	beforeEach(async () => {
		fired.length = 0;
		FakeNotification.permission = "granted";
		// Start every case with the push list not established.
		subscribeAccepted = false;
		await ensurePushSubscription();
	});

	test("fires for a local event when this browser has no push subscription", () => {
		fireHookNotification("Stop", uniqueCwd(), "s1");
		expect(fired).toHaveLength(1);
		expect(fired[0]?.options.body).toBe("Response complete");
	});

	test("stays quiet for a local event once push is delivering", async () => {
		await subscribe();
		fireHookNotification("Stop", uniqueCwd(), "s1");
		expect(fired).toHaveLength(0);
	});

	test("treats an explicit local peer id the same as none", async () => {
		await subscribe();
		fireHookNotification("Stop", uniqueCwd(), "s1", undefined, undefined, LOCAL_PEER_ID);
		expect(fired).toHaveLength(0);
	});

	test("still fires for a peer's event, whose push goes elsewhere", async () => {
		await subscribe();
		fireHookNotification("Stop", uniqueCwd(), "s1", undefined, undefined, "beelink");
		expect(fired).toHaveLength(1);
		expect(fired[0]?.options.data?.peerId).toBe("beelink");
	});

	test("fires again for a local event after the subscription is refused", async () => {
		await subscribe();
		subscribeAccepted = false;
		await ensurePushSubscription();
		fireHookNotification("Stop", uniqueCwd(), "s1");
		expect(fired).toHaveLength(1);
	});

	test("debounces the same event and cwd", () => {
		const cwd = uniqueCwd();
		fireHookNotification("Stop", cwd, "s1");
		fireHookNotification("Stop", cwd, "s1");
		expect(fired).toHaveLength(1);
	});
});
