import { describe, expect, it } from "vitest";
import { formatDuration, formatRemaining } from "../src/format.ts";

describe("formatDuration", () => {
	it.each([
		[250, "250ms"],
		[1284, "1.3s"],
		[2000, "2s"],
		[45_000, "45s"],
		[90_000, "1m 30s"],
		[300_250, "5m"],
		[1_800_000, "30m"],
		[7_200_000, "2h"],
		[4_500_000, "1h 15m"],
	])("%i ms → %s", (ms, text) => {
		expect(formatDuration(ms)).toBe(text);
	});
});

describe("formatRemaining", () => {
	it("rounds up to whole seconds and never shows zero", () => {
		expect(formatRemaining(30_000)).toBe("30s");
		expect(formatRemaining(29_001)).toBe("30s");
		expect(formatRemaining(1)).toBe("1s");
	});
});
