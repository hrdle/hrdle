import { describe, expect, test } from "bun:test";
import type { KimiUsageDay } from "../../../../shared/types";
import { amountLabelDates } from "./KimiDailyCostChart";

function days(costs: (number | undefined)[]): KimiUsageDay[] {
	// Dates ascend from 2026-08-01 so the last entry is "today".
	return costs.map((costUsd, i) => ({
		date: `2026-08-${String(i + 1).padStart(2, "0")}`,
		turns: costUsd ? 1 : 0,
		totalTokens: costUsd ? 1000 : 0,
		costUsd,
		observed: true,
	}));
}

/**
 * The amounts are printed on the bars because the tooltips they replace do not
 * exist on a touch screen, and this panel is read on a tablet. Which makes
 * "who gets a label" the whole design: all of them where they fit, the ones
 * worth scanning for where they do not.
 */
describe("amountLabelDates", () => {
	test("a short range labels every day that cost something", () => {
		const labels = amountLabelDates(days([0, 0.13, 0, 4.32, 0.58]));
		expect([...labels].sort()).toEqual([
			"2026-08-02",
			"2026-08-04",
			"2026-08-05",
		]);
	});

	test("free days get no label - a zero bar has nothing to say", () => {
		expect(amountLabelDates(days([0, 0, 0]))).toEqual(new Set());
	});

	test("unpriceable days get no label either", () => {
		// An absent cost is unknown, and printing anything there would invent it.
		expect(amountLabelDates(days([undefined, undefined]))).toEqual(new Set());
	});

	test("adjacent days may both be labelled while the range is short", () => {
		// The common case on a fresh install: yesterday's big day next to today.
		const labels = amountLabelDates(days([0, 0, 4.32, 0.58]));
		expect(labels.has("2026-08-03")).toBe(true);
		expect(labels.has("2026-08-04")).toBe(true);
	});

	test("a long range thins the labels rather than overprinting them", () => {
		const labels = amountLabelDates(days(Array.from({ length: 30 }, (_, i) => i + 1)));
		expect(labels.size).toBeLessThanOrEqual(6);
	});

	test("and never puts two of them side by side", () => {
		const series = days(Array.from({ length: 30 }, (_, i) => i + 1));
		const labelled = series
			.map((d, i) => (amountLabelDates(series).has(d.date) ? i : -1))
			.filter((i) => i >= 0)
			.sort((a, b) => a - b);
		for (let i = 1; i < labelled.length; i++) {
			expect(labelled[i] - labelled[i - 1]).toBeGreaterThanOrEqual(2);
		}
	});

	test("today is labelled even when it is a cheap day among expensive ones", () => {
		// It is the day being asked about; losing it to a ranking by size would
		// answer a question nobody asked.
		const costs = Array.from({ length: 30 }, () => 10);
		costs[29] = 0.01;
		const labels = amountLabelDates(days(costs));
		expect(labels.has("2026-08-30")).toBe(true);
	});

	test("the most expensive day is always labelled", () => {
		// The spike is the whole reason to look at a spending chart.
		const costs = Array.from({ length: 30 }, () => 1);
		costs[17] = 99;
		expect(amountLabelDates(days(costs)).has("2026-08-18")).toBe(true);
	});

	test("and it keeps its label when today is the bar next door", () => {
		// The case that was wrong: today ranked first, then blocked the peak
		// beside it, so the tallest bar in the chart went unmarked.
		const costs = Array.from({ length: 30 }, () => 1);
		costs[28] = 4.32;
		costs[29] = 0.58;
		const labels = amountLabelDates(days(costs));
		expect(labels.has("2026-08-29")).toBe(true);
		expect(labels.has("2026-08-30")).toBe(false);
	});

	test("the biggest days win the remaining slots", () => {
		const costs = Array.from({ length: 30 }, () => 0.01);
		costs[4] = 99;
		costs[14] = 88;
		const labels = amountLabelDates(days(costs));
		expect(labels.has("2026-08-05")).toBe(true);
		expect(labels.has("2026-08-15")).toBe(true);
	});
});
