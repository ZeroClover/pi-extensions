import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.ts";
import { RunTracker } from "../src/run.ts";
import type { RequestRecord } from "../src/telemetry.ts";

class FakeClock implements Clock {
	t = 0;
	now(): number {
		return this.t;
	}
}

function request(outputTokens: number, thinkingTokens?: number): RequestRecord {
	const record: RequestRecord = {
		timestamp: 1,
		provider: "p",
		model: "m",
		outcome: "settled",
		burst: false,
		elapsedMs: 1000,
		outputMs: 800,
		generationMs: 800,
		generatedTokens: outputTokens,
		thinking: thinkingTokens === undefined ? "none" : "streamed",
		estimated: false,
		inputTokens: 10,
		outputTokens,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		deltaCount: 10,
		stallCount: 0,
		stallMs: 0,
	};
	if (thinkingTokens !== undefined) record.thinkingTokens = thinkingTokens;
	return record;
}

let clock: FakeClock;
let tracker: RunTracker;

beforeEach(() => {
	clock = new FakeClock();
	tracker = new RunTracker(clock);
});

describe("RunTracker", () => {
	it("groups the requests of a prompt with tool calls into one run (tool calls)", () => {
		clock.t = 100;
		expect(tracker.start(1_700_000_000_000)).toBe(true);
		tracker.add(request(100));
		clock.t = 5000;
		expect(tracker.snapshot()).toEqual({
			phase: "working",
			elapsedMs: 4900,
			requests: 1,
			outputTokens: 100,
			estimated: false,
		});
		tracker.add(request(200, 50));
		tracker.add(request(300));
		clock.t = 18_500;
		const run = tracker.settle(false);
		expect(run).toMatchObject({ version: 2, startedAt: 1_700_000_000_000, elapsedMs: 18_400, aborted: false });
		expect(run?.requests).toHaveLength(3);
		expect(tracker.active).toBe(false);
	});

	it("keeps later agent starts in the same run (automatic retry after an error)", () => {
		tracker.start(1);
		clock.t = 2000;
		expect(tracker.start(2)).toBe(false);
		tracker.add(request(100));
		clock.t = 3000;
		expect(tracker.settle(false)?.elapsedMs).toBe(3000);
	});

	it("discards a run without measured requests", () => {
		tracker.start(1);
		expect(tracker.settle(false)).toBeUndefined();
		expect(tracker.settle(false)).toBeUndefined();
	});

	it("records the abort flag and counts visible output while working", () => {
		tracker.start(1);
		tracker.add(request(500, 200));
		expect(tracker.snapshot()?.outputTokens).toBe(300);
		expect(tracker.requestCount).toBe(1);
		expect(tracker.settle(true)?.aborted).toBe(true);
	});

	it("marks the working output when a request's thinking tokens are estimated", () => {
		tracker.start(1);
		const record = request(500, 200);
		tracker.add(record);
		expect(tracker.snapshot()?.estimated).toBe(true);
		tracker.discard();
		tracker.start(1);
		tracker.add({ ...record, reasoningTokens: 200 });
		expect(tracker.snapshot()?.estimated).toBe(false);
	});

	it("ignores records and has no snapshot while idle", () => {
		tracker.add(request(1));
		expect(tracker.snapshot()).toBeUndefined();
		tracker.start(1);
		tracker.discard();
		expect(tracker.active).toBe(false);
	});
});
