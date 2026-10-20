import { describe, expect, it } from "vitest";
import { backoffDelay, retryDelay } from "../src/backoff.ts";

const CONFIG = { baseDelayMs: 2000, maxBackoffMs: 60_000 };

describe("backoffDelay", () => {
	it("Backoff sequence", () => {
		const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelay(CONFIG, attempt, () => 1));
		expect(delays).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
	});

	it("draws the jitter factor from [0.75, 1.0]", () => {
		expect(backoffDelay(CONFIG, 1, () => 0)).toBe(1500);
		expect(backoffDelay(CONFIG, 1, () => 0.5)).toBe(1750);
		for (let index = 0; index < 200; index++) {
			const delay = backoffDelay(CONFIG, 3, Math.random);
			expect(delay).toBeGreaterThanOrEqual(6000);
			expect(delay).toBeLessThanOrEqual(8000);
		}
	});

	it("stays at the cap for very large attempts", () => {
		expect(backoffDelay(CONFIG, 2000, () => 1)).toBe(60_000);
	});
});

describe("retryDelay", () => {
	it("Hint beyond the backoff cap", () => {
		expect(retryDelay({ hint: { delayMs: 300_000, source: "header retry-after" } }, CONFIG, 1, () => 0)).toBe(300_250);
	});

	it("uses backoff without a hint", () => {
		expect(retryDelay({}, CONFIG, 2, () => 1)).toBe(4000);
	});
});
