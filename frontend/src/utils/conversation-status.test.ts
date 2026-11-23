import { describe, expect, test } from "bun:test";
import { conversationStatus } from "./conversation-status";

const base = {
	agent: "claude",
	agentSessionId: "58ece9ab-0000",
	isReady: true,
	messageCount: 3,
	found: true,
};

describe("conversationStatus", () => {
	test("a pane with no agent says so", () => {
		expect(conversationStatus({ ...base, agent: undefined })).toBe(
			"missing-agent",
		);
	});

	test("an agent outside the registry is unsupported", () => {
		expect(conversationStatus({ ...base, agent: "vim" })).toBe(
			"unsupported-agent",
		);
	});

	test("an agent without its session id is named, not guessed", () => {
		expect(conversationStatus({ ...base, agentSessionId: null })).toBe(
			"no-session-id",
		);
		expect(
			conversationStatus({ ...base, agent: "codex", agentSessionId: undefined }),
		).toBe("no-session-id");
	});

	test("a thread agent without an id does not wait forever", () => {
		// The reader never starts without an id, so isReady never turns true.
		expect(
			conversationStatus({
				agent: "kimi",
				agentSessionId: null,
				isReady: false,
				messageCount: 0,
			}),
		).toBe("no-session-id");
	});

	test("loading only while the first answer has not arrived", () => {
		expect(
			conversationStatus({ ...base, isReady: false, messageCount: 0 }),
		).toBe("loading");
	});

	test("an id with no transcript behind it is not-found", () => {
		expect(
			conversationStatus({ ...base, found: false, messageCount: 0 }),
		).toBe("not-found");
	});

	test("a transcript with nothing in it yet is empty", () => {
		expect(conversationStatus({ ...base, messageCount: 0 })).toBe("empty");
		expect(
			conversationStatus({
				agent: "codex",
				agentSessionId: "019a",
				isReady: true,
				messageCount: 0,
			}),
		).toBe("empty");
	});

	test("messages are shown", () => {
		expect(conversationStatus(base)).toBe("ready");
	});
});
