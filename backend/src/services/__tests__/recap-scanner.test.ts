import { describe, expect, test } from "bun:test";
import { parseRecapFromLines } from "../../utils/recap-scanner";

function jsonl(...entries: unknown[]): string[] {
	return entries.map((e) => JSON.stringify(e));
}

const userRecapTrigger = {
	type: "user",
	message: {
		content: [
			{ type: "text", text: "<command-name>/recap</command-name>" },
		],
	},
};

describe("parseRecapFromLines", () => {
	test("empty input → null", () => {
		expect(parseRecapFromLines([])).toBeNull();
	});

	test("away_summary is picked up and the config hint is stripped", () => {
		const lines = jsonl({
			type: "system",
			subtype: "away_summary",
			content: "Progress: implementing PR2. (disable recaps in /config)",
			timestamp: "2026-05-30T10:00:00Z",
		});
		const recap = parseRecapFromLines(lines);
		expect(recap).toEqual({
			content: "Progress: implementing PR2.",
			timestamp: "2026-05-30T10:00:00Z",
		});
	});

	test("local_command recap requires a preceding /recap user trigger", () => {
		const withTrigger = jsonl(userRecapTrigger, {
			type: "system",
			subtype: "local_command",
			content: "<local-command-stdout>手動 recap 本文</local-command-stdout>",
			timestamp: "2026-05-30T11:00:00Z",
		});
		expect(parseRecapFromLines(withTrigger)).toEqual({
			content: "手動 recap 本文",
			timestamp: "2026-05-30T11:00:00Z",
		});

		// Same local_command WITHOUT the preceding /recap trigger is ignored.
		const withoutTrigger = jsonl({
			type: "system",
			subtype: "local_command",
			content: "<local-command-stdout>output of another command</local-command-stdout>",
			timestamp: "2026-05-30T11:00:00Z",
		});
		expect(parseRecapFromLines(withoutTrigger)).toBeNull();
	});

	test("local_command API Error output is skipped", () => {
		const lines = jsonl(userRecapTrigger, {
			type: "system",
			subtype: "local_command",
			content: "<local-command-stdout>API Error: 529 overloaded</local-command-stdout>",
			timestamp: "2026-05-30T11:00:00Z",
		});
		expect(parseRecapFromLines(lines)).toBeNull();
	});

	test("most recent recap wins when both sources are present", () => {
		const lines = jsonl(
			{
				type: "system",
				subtype: "away_summary",
				content: "older automatic recap",
				timestamp: "2026-05-30T09:00:00Z",
			},
			userRecapTrigger,
			{
				type: "system",
				subtype: "local_command",
				content: "<local-command-stdout>newer manual recap</local-command-stdout>",
				timestamp: "2026-05-30T12:00:00Z",
			},
		);
		expect(parseRecapFromLines(lines)?.content).toBe("newer manual recap");
	});

	test("a later away_summary overrides an earlier one", () => {
		const lines = jsonl(
			{
				type: "system",
				subtype: "away_summary",
				content: "1回目",
				timestamp: "2026-05-30T09:00:00Z",
			},
			{
				type: "system",
				subtype: "away_summary",
				content: "2回目",
				timestamp: "2026-05-30T10:00:00Z",
			},
		);
		expect(parseRecapFromLines(lines)?.content).toBe("2回目");
	});

	test("an away_summary between /recap and its local_command clears the trigger", () => {
		const lines = jsonl(
			userRecapTrigger,
			{
				type: "system",
				subtype: "away_summary",
				content: "automatic summary",
				timestamp: "2026-05-30T10:00:00Z",
			},
			{
				type: "system",
				subtype: "local_command",
				content: "<local-command-stdout>output whose trigger was taken</local-command-stdout>",
				timestamp: "2026-05-30T11:00:00Z",
			},
		);
		// The away_summary consumes the pending trigger, so the local_command is
		// NOT treated as a recap; the away_summary itself is the latest recap.
		expect(parseRecapFromLines(lines)?.content).toBe("automatic summary");
	});

	test("a non-/recap user entry clears a pending trigger", () => {
		const lines = jsonl(
			userRecapTrigger,
			{ type: "user", message: { content: "an ordinary message" } },
			{
				type: "system",
				subtype: "local_command",
				content: "<local-command-stdout>this is not a recap</local-command-stdout>",
				timestamp: "2026-05-30T11:00:00Z",
			},
		);
		expect(parseRecapFromLines(lines)).toBeNull();
	});

	test("invalid JSON lines are skipped without throwing", () => {
		const lines = [
			"not json",
			"",
			JSON.stringify({
				type: "system",
				subtype: "away_summary",
				content: "recap after a broken line",
				timestamp: "2026-05-30T10:00:00Z",
			}),
		];
		expect(parseRecapFromLines(lines)?.content).toBe("recap after a broken line");
	});

	test("empty away_summary content does not produce a recap", () => {
		const lines = jsonl({
			type: "system",
			subtype: "away_summary",
			content: " (disable recaps in /config)",
			timestamp: "2026-05-30T10:00:00Z",
		});
		expect(parseRecapFromLines(lines)).toBeNull();
	});
});
