import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type StopSignal, waitFor } from "../src/wait.ts";

let start = 0;

beforeEach(() => {
	vi.useFakeTimers();
	start = Date.now();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("waitFor", () => {
	it("completes after the delay and ticks once per second", async () => {
		const ticks: number[] = [];
		const done = waitFor(3500, { shouldStop: () => undefined, onTick: (remaining) => ticks.push(remaining) });
		await vi.advanceTimersByTimeAsync(3500);
		await expect(done).resolves.toBe("completed");
		expect(ticks).toEqual([3500, 2500, 1500, 500]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		["cancel", "cancelled"],
		["proceed", "proceed"],
	] as const)("ends within one slice on %s", async (signal: StopSignal, outcome) => {
		let stop: StopSignal | undefined;
		const done = waitFor(60_000, { shouldStop: () => stop, onTick: () => {} });
		await vi.advanceTimersByTimeAsync(10_000);
		stop = signal;
		await vi.advanceTimersByTimeAsync(1000);
		await expect(done).resolves.toBe(outcome);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("wakes at once when the wake signal aborts", async () => {
		let stop: StopSignal | undefined;
		const wake = new AbortController();
		const done = waitFor(60_000, { shouldStop: () => stop, onTick: () => {}, wake: wake.signal });
		await vi.advanceTimersByTimeAsync(2500);
		stop = "cancel";
		wake.abort();
		await expect(done).resolves.toBe("cancelled");
		expect(Date.now() - start).toBe(2500);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("checks the stop signal before the first slice", async () => {
		await expect(waitFor(1000, { shouldStop: () => "cancel", onTick: () => {} })).resolves.toBe("cancelled");
		expect(vi.getTimerCount()).toBe(0);
	});
});
