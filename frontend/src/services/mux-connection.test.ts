import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import type { MuxCallbacks } from "./mux-connection";

type Mux = typeof import("./mux-connection");
type Sent = Record<string, unknown>;

// --- a browser, as much of one as the socket layer touches -------------------

class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static all: FakeSocket[] = [];

	readyState = FakeSocket.CONNECTING;
	sent: Sent[] = [];
	closeCalls = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(readonly url: string) {
		FakeSocket.all.push(this);
	}

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}

	/** Like a browser: the close event comes later, not inside `close()`. */
	close() {
		this.closeCalls++;
		if (this.readyState === FakeSocket.CLOSED) return;
		this.readyState = FakeSocket.CLOSING;
	}

	open() {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}

	receive(msg: Record<string, unknown>) {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}

	closed(code = 1006) {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.({ code, reason: "" });
	}
}

interface Timer {
	id: number;
	at: number;
	every?: number;
	fn: () => void;
}

let now = 1_000_000;
let timers: Timer[] = [];
let nextTimerId = 1;
const listeners = new Map<string, Array<() => void>>();
const documentListeners = new Map<string, Array<() => void>>();
const dispatched: Array<{ type: string; detail: unknown }> = [];
const store = new Map<string, string>();

function schedule(fn: () => void, ms: number, every?: number): number {
	const id = nextTimerId++;
	timers.push({ id, at: now + ms, every, fn });
	return id;
}

function cancel(id: number) {
	timers = timers.filter((t) => t.id !== id);
}

/** Moves the clock, running each timer that comes due, in order. */
function advance(ms: number) {
	const end = now + ms;
	for (;;) {
		const due = timers
			.filter((t) => t.at <= end)
			.sort((a, b) => a.at - b.at)[0];
		if (!due) break;
		now = due.at;
		setSystemTime(new Date(now));
		if (due.every) due.at += due.every;
		else cancel(due.id);
		due.fn();
	}
	now = end;
	setSystemTime(new Date(now));
}

const fakeDocument = {
	hidden: false,
	visibilityState: "visible",
	addEventListener(type: string, fn: () => void) {
		documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]);
	},
	removeEventListener() {},
};

const fakeWindow = {
	location: { protocol: "https:", host: "hub.test:5924" },
	setTimeout: (fn: () => void, ms: number) => schedule(fn, ms),
	setInterval: (fn: () => void, ms: number) => schedule(fn, ms, ms),
	clearTimeout: cancel,
	clearInterval: cancel,
	addEventListener(type: string, fn: () => void) {
		listeners.set(type, [...(listeners.get(type) ?? []), fn]);
	},
	dispatchEvent(event: { type: string; detail?: unknown }) {
		dispatched.push({ type: event.type, detail: event.detail });
		return true;
	},
};

const saved = {
	window: globalThis.window,
	document: globalThis.document,
	WebSocket: globalThis.WebSocket,
	localStorage: globalThis.localStorage,
};

beforeAll(() => {
	Object.assign(globalThis, {
		window: fakeWindow,
		document: fakeDocument,
		WebSocket: FakeSocket,
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
			removeItem: (k: string) => store.delete(k),
		},
	});
});

afterAll(() => {
	Object.assign(globalThis, saved);
	setSystemTime();
});

// --- per test: a fresh module, so no socket or subscription carries over -----

let loads = 0;
let mux: Mux;
let events: string[];

async function freshMux(): Promise<Mux> {
	return (await import(`./mux-connection.ts?fresh=${loads++}`)) as Mux;
}

function callbacks(over: Partial<MuxCallbacks> = {}): MuxCallbacks {
	return {
		sessionId: "w1",
		setIsConnected: (v) => events.push(`connected:${v}`),
		onConnect: () => events.push("onConnect"),
		onDisconnect: () => events.push("onDisconnect"),
		onSessionExit: (r) => events.push(`exit:${r}`),
		onError: (e, p) => events.push(`error:${e}${p ? `@${p}` : ""}`),
		onPaneViewport: (p) => events.push(`viewport:${p}`),
		onLayoutChange: (_l, z) => events.push(`layout:${z}`),
		onHookEvent: (e, _c, s) => events.push(`hook:${e}:${s}`),
		onHerdrRestart: (phase) => events.push(`herdr:${phase}`),
		...over,
	};
}

function socket(index = -1): FakeSocket {
	return FakeSocket.all.at(index) as FakeSocket;
}

/** Connects, opens and readies a socket for session `w1`. */
function connected(over: Partial<MuxCallbacks> = {}): FakeSocket {
	mux.setMuxCallbacks(callbacks(over));
	mux.ensureConnection();
	const ws = socket();
	ws.open();
	ws.receive({ type: "ready" });
	return ws;
}

function types(ws: FakeSocket): string[] {
	return ws.sent.map((m) => String(m.type));
}

beforeEach(async () => {
	FakeSocket.all = [];
	timers = [];
	listeners.clear();
	documentListeners.clear();
	dispatched.length = 0;
	store.clear();
	events = [];
	fakeDocument.hidden = false;
	fakeDocument.visibilityState = "visible";
	now = 1_000_000;
	setSystemTime(new Date(now));
	mux = await freshMux();
});

// --- the tests ---------------------------------------------------------------

describe("connecting", () => {
	test("dials the page's own host with the stored token and the device id", () => {
		store.set("hrdle-token", "tok en");
		store.set("hrdle-device-id", "dev-1");
		mux.ensureConnection();
		expect(socket().url).toBe(
			"wss://hub.test:5924/ws/mux?token=tok%20en&deviceId=dev-1",
		);
	});

	test("a given base and token win over the page's own", () => {
		mux.ensureConnection("peer-token", "wss://peer.test:5924");
		expect(socket().url).toStartWith(
			"wss://peer.test:5924/ws/mux?token=peer-token&deviceId=",
		);
	});

	test("asking again while open or still connecting opens nothing new", () => {
		mux.ensureConnection();
		mux.ensureConnection();
		socket().open();
		mux.ensureConnection();
		expect(FakeSocket.all).toHaveLength(1);
	});

	test("a handshake that never finishes is closed after ten seconds", () => {
		mux.ensureConnection();
		advance(9_999);
		expect(socket().closeCalls).toBe(0);
		advance(1);
		expect(socket().closeCalls).toBe(1);
	});

	test("a stale handshake is replaced when asked again", () => {
		mux.ensureConnection();
		advance(10_000);
		socket().closed();
		mux.ensureConnection();
		expect(FakeSocket.all).toHaveLength(2);
	});
});

describe("subscribing to the session", () => {
	test("ready subscribes the active session as a replay", () => {
		const ws = connected();
		expect(ws.sent).toEqual([
			{ type: "subscribe", sessionId: "w1", resumed: true },
		]);
		expect(events).toEqual(["connected:false"]);
	});

	test("the server's subscribed marks this client connected", () => {
		const ws = connected();
		events = [];
		ws.receive({ type: "subscribed", sessionId: "other" });
		expect(events).toEqual([]);
		ws.receive({ type: "subscribed", sessionId: "w1" });
		expect(events).toEqual(["connected:true", "onConnect"]);
	});

	test("nothing is sent before ready; ready does it", () => {
		mux.setMuxCallbacks(callbacks());
		mux.ensureConnection();
		socket().open();
		mux.subscribeWhenReady("w1");
		expect(socket().sent).toEqual([]);
	});

	test("the same session twice is one subscription", () => {
		const ws = connected();
		mux.subscribeWhenReady("w1");
		expect(types(ws)).toEqual(["subscribe"]);
	});

	test("another session unsubscribes the first", () => {
		const ws = connected();
		mux.setMuxCallbacks(callbacks({ sessionId: "w2" }));
		mux.subscribeWhenReady("w2");
		expect(ws.sent.slice(1)).toEqual([
			{ type: "unsubscribe", sessionId: "w1" },
			{ type: "subscribe", sessionId: "w2", resumed: false },
		]);
	});

	test("a new workspace under the same id is subscribed afresh", () => {
		const ws = connected({ sessionInstanceId: "a" });
		mux.subscribeWhenReady("w1", "b");
		expect(types(ws)).toEqual(["subscribe", "unsubscribe", "subscribe"]);
	});

	test("remote-control mode never subscribes", () => {
		const ws = connected({ live: false });
		mux.subscribeWhenReady("w1");
		expect(ws.sent).toEqual([]);
	});

	test("dropping the subscription lets the next one through", () => {
		const ws = connected();
		mux.dropSessionSubscription();
		mux.subscribeWhenReady("w1");
		expect(types(ws)).toEqual(["subscribe", "unsubscribe", "subscribe"]);
	});

	test("session messages carry the active session's id", () => {
		const ws = connected();
		mux.sendSessionMessage({ type: "split", paneId: "%1", direction: "h" });
		expect(ws.sent.at(-1)).toEqual({
			type: "split",
			paneId: "%1",
			direction: "h",
			sessionId: "w1",
		});
	});
});

describe("routing what the server sends", () => {
	test("frames for another session are not this layout's", () => {
		const ws = connected();
		events = [];
		ws.receive({ type: "viewport", sessionId: "w9", viewport: { paneId: "%1" } });
		ws.receive({ type: "layout", sessionId: "w9", layout: {} });
		ws.receive({ type: "viewport", sessionId: "w1", viewport: { paneId: "%2" } });
		ws.receive({ type: "layout", sessionId: "w1", layout: {}, zoomedPaneId: "%2" });
		ws.receive({ type: "layout", sessionId: "w1", layout: {} });
		expect(events).toEqual(["viewport:%2", "layout:%2", "layout:null"]);
	});

	test("an error is delivered unless it names another session", () => {
		const ws = connected();
		events = [];
		ws.receive({ type: "error", sessionId: "w9", message: "theirs" });
		ws.receive({ type: "error", sessionId: "w1", message: "ours", paneId: "%3" });
		ws.receive({ type: "error", message: "global" });
		expect(events).toEqual(["error:ours@%3", "error:global"]);
	});

	test("hook events arrive whichever session they are from", () => {
		const ws = connected();
		events = [];
		ws.receive({ type: "hook-event", event: "Stop", sessionId: "w9" });
		expect(events).toEqual(["hook:Stop:w9"]);
	});

	test("conversation frames go out as a window event", () => {
		const ws = connected();
		const msg = { type: "conversation-update", sessionId: "w1", messages: [] };
		ws.receive(msg);
		expect(dispatched).toEqual([{ type: "hrdle-conversation", detail: msg }]);
	});

	test("an exited session can be subscribed again", () => {
		const ws = connected();
		events = [];
		ws.receive({ type: "session-exited", sessionId: "w1", reason: "closed" });
		expect(events).toEqual(["connected:false", "exit:closed"]);
		mux.subscribeWhenReady("w1");
		expect(types(ws)).toEqual(["subscribe", "subscribe"]);
	});

	test("a herdr restart resubscribes once it is over", () => {
		const ws = connected();
		events = [];
		ws.receive({ type: "herdr-restart", phase: "restarting" });
		expect(types(ws)).toEqual(["subscribe"]);
		ws.receive({ type: "herdr-restart", phase: "restored" });
		expect(events).toEqual(["herdr:restarting", "herdr:restored", "connected:false"]);
		expect(ws.sent.at(-1)).toEqual({
			type: "subscribe",
			sessionId: "w1",
			resumed: true,
		});
	});

	test("anything that is not JSON text is ignored", () => {
		const ws = connected();
		events = [];
		ws.onmessage?.({ data: "not json" });
		ws.onmessage?.({ data: new Uint8Array([1]) });
		expect(events).toEqual([]);
	});
});

describe("keeping the socket alive", () => {
	test("pings every ten seconds with the active session", () => {
		const ws = connected();
		advance(10_000);
		expect(ws.sent.at(-1)).toMatchObject({ type: "ping", sessionId: "w1" });
	});

	test("closes a socket the server has stopped answering", () => {
		const ws = connected();
		advance(20_000);
		expect(ws.closeCalls).toBe(0);
		advance(10_000);
		expect(ws.closeCalls).toBe(1);
	});

	test("a pong keeps it open", () => {
		const ws = connected();
		for (let i = 0; i < 5; i++) {
			advance(10_000);
			ws.receive({ type: "pong", timestamp: now - 5 });
		}
		expect(ws.closeCalls).toBe(0);
	});

	test("a dropped socket reconnects two seconds later to the same server", () => {
		mux.ensureConnection("t", "wss://peer.test");
		const ws = socket();
		ws.open();
		ws.closed(1006);
		advance(1_999);
		expect(FakeSocket.all).toHaveLength(1);
		advance(1);
		expect(socket().url).toStartWith("wss://peer.test/ws/mux?token=t&");
	});

	test("a clean close does not reconnect", () => {
		mux.ensureConnection();
		socket().open();
		socket().closed(1000);
		advance(60_000);
		expect(FakeSocket.all).toHaveLength(1);
	});

	test("a drop tells the layout and resubscribes on the next ready", () => {
		const ws = connected();
		events = [];
		ws.closed();
		expect(events).toEqual(["connected:false", "onDisconnect"]);
		advance(2_000);
		socket().open();
		socket().receive({ type: "ready" });
		expect(socket().sent).toEqual([
			{ type: "subscribe", sessionId: "w1", resumed: true },
		]);
	});

	test("a page shown again with its socket gone reconnects at once", () => {
		mux.registerVisibilityListener();
		const ws = connected();
		ws.closed();
		for (const fn of documentListeners.get("visibilitychange") ?? []) fn();
		expect(FakeSocket.all).toHaveLength(2);
	});

	test("a page shown again mid-handshake gives up on it after three seconds", () => {
		mux.registerVisibilityListener();
		mux.ensureConnection();
		advance(3_001);
		for (const fn of documentListeners.get("visibilitychange") ?? []) fn();
		expect(socket().closeCalls).toBe(1);
	});

	test("the network coming back replaces the socket", () => {
		mux.registerVisibilityListener();
		const ws = connected();
		for (const fn of listeners.get("online") ?? []) fn();
		expect(ws.closeCalls).toBe(1);
		expect(FakeSocket.all).toHaveLength(2);
	});
});

describe("switching servers", () => {
	test("a new base closes the old socket and opens one there", () => {
		const first = connected();
		mux.ensureConnection(null, "wss://peer.test");
		expect(first.closeCalls).toBe(1);
		expect(socket().url).toStartWith("wss://peer.test/ws/mux");
	});

	test("the old socket's late close touches nothing", () => {
		const first = connected();
		mux.ensureConnection(null, "wss://peer.test");
		const second = socket();
		events = [];
		first.closed();
		advance(5_000);
		expect(events).toEqual([]);
		expect(FakeSocket.all).toHaveLength(2);
		second.open();
		second.receive({ type: "ready" });
		expect(types(second)).toEqual(["subscribe"]);
	});

	test("a new token is a new connection too", () => {
		mux.ensureConnection("a", "wss://peer.test");
		mux.ensureConnection("b", "wss://peer.test");
		expect(FakeSocket.all).toHaveLength(2);
	});
});

describe("conversations", () => {
	test("asked for while down: connects, then subscribes on ready", () => {
		mux.subscribeConversation("w1", "agent-a");
		const ws = socket();
		ws.open();
		expect(ws.sent).toEqual([]);
		ws.receive({ type: "ready" });
		expect(ws.sent).toEqual([
			{ type: "subscribe-conversation", sessionId: "w1", agentSessionId: "agent-a" },
		]);
	});

	test("asked for twice while up: sent once", () => {
		const ws = connected({ live: false });
		mux.subscribeConversation("w1");
		mux.subscribeConversation("w1");
		expect(ws.sent).toEqual([{ type: "subscribe-conversation", sessionId: "w1" }]);
	});

	test("two panes of one workspace are two subscriptions", () => {
		const ws = connected({ live: false });
		mux.subscribeConversation("w1", "agent-a");
		mux.subscribeConversation("w1", "agent-b");
		mux.unsubscribeConversation("w1", "agent-a");
		expect(ws.sent.map((m) => `${m.type}:${m.agentSessionId}`)).toEqual([
			"subscribe-conversation:agent-a",
			"subscribe-conversation:agent-b",
			"unsubscribe-conversation:agent-a",
		]);
	});

	test("they are taken up again on a new socket", () => {
		const ws = connected({ live: false });
		mux.subscribeConversation("w1", "agent-a");
		ws.closed();
		advance(2_000);
		socket().open();
		socket().receive({ type: "ready" });
		expect(socket().sent).toEqual([
			{ type: "subscribe-conversation", sessionId: "w1", agentSessionId: "agent-a" },
		]);
	});

	test("one dropped while down is not taken up again", () => {
		const ws = connected({ live: false });
		mux.subscribeConversation("w1");
		ws.closed();
		mux.unsubscribeConversation("w1");
		advance(2_000);
		socket().open();
		socket().receive({ type: "ready" });
		expect(types(socket())).toEqual(["unsubscribe-conversation"]);
	});

	test("reconnects to the server the socket was serving", () => {
		mux.ensureConnection("t", "wss://peer.test");
		socket().closed(1000);
		mux.subscribeConversation("w1");
		expect(socket().url).toStartWith("wss://peer.test/ws/mux?token=t&");
	});
});

describe("declaring the device", () => {
	test("the first declaration is fresh, every later one is not", () => {
		const ws = connected({ live: false });
		mux.declareClient("mobile");
		mux.declareClient("mobile");
		expect(ws.sent.map((m) => m.fresh)).toEqual([true, false]);
		expect(ws.sent[0]).toMatchObject({
			type: "client-info",
			deviceType: "mobile",
			visible: true,
			sessionId: "w1",
		});
	});

	test("redeclaring reports the page hidden under the type last declared", () => {
		const ws = connected({ live: false });
		mux.redeclareClient();
		expect(ws.sent).toEqual([]);
		mux.declareClient("tablet");
		fakeDocument.hidden = true;
		mux.redeclareClient();
		expect(ws.sent.at(-1)).toMatchObject({
			deviceType: "tablet",
			visible: false,
			fresh: false,
		});
	});
});
