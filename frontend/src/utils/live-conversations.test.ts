import { describe, expect, test } from "bun:test";
import { liveConversations } from "./live-conversations";

describe("liveConversations", () => {
	test("a workspace's second agent pane is live too", () => {
		const frame = {
			id: "w4H",
			ccSessionId: "e109de63",
			panes: [{ agentSessionId: "417cffd6" }, { agentSessionId: "e109de63" }],
		};
		const live = liveConversations([frame]);
		expect(live.get("417cffd6")?.id).toBe("w4H");
		expect(live.get("e109de63")?.id).toBe("w4H");
	});

	test("a thread agent with no ccSessionId is live by its pane", () => {
		const live = liveConversations([
			{ id: "w9", panes: [{ agentSessionId: "019ff499" }] },
		]);
		expect(live.has("019ff499")).toBe(true);
	});

	test("a conversation that is not running is absent", () => {
		const live = liveConversations([{ id: "w1", ccSessionId: "aaaa" }]);
		expect(live.has("bbbb")).toBe(false);
	});
});
