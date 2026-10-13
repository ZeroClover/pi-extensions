import { describe, expect, it } from "vitest";
import { summarizeRun } from "../src/aggregate.ts";
import type { Clock } from "../src/clock.ts";
import { formatSnapshot, plainText } from "../src/format.ts";
import { type EndInput, Measurement } from "../src/measurement.ts";
import { RunTracker } from "../src/run.ts";
import { parseRunRecord, type RequestRecord, type RunRecord } from "../src/telemetry.ts";

class FakeClock implements Clock {
	t = 0;
	now(): number {
		return this.t;
	}
}

function end(output: number): EndInput {
	return {
		stopReason: "stop",
		provider: "p",
		model: "m",
		usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	};
}

/** Runs one request through Measurement and RunTracker and returns the run as persisted and read back. */
function persistedRun(clock: FakeClock, feed: (meter: Measurement) => void, output: number): RunRecord {
	const meter = new Measurement(clock, () => ({ add: (_stream, delta) => delta.length }));
	const run = new RunTracker(clock);
	run.start(1);
	meter.turnStart();
	meter.requestStart({ provider: "p", model: "m", wallTime: 1 });
	meter.messageStart();
	feed(meter);
	const outcome = meter.end(end(output));
	if (outcome.kind !== "recorded") throw new Error(`expected a record, got ${outcome.kind}`);
	run.add(outcome.record);
	const record = run.settle(false);
	const parsed = parseRunRecord(JSON.parse(JSON.stringify(record)));
	if (!parsed) throw new Error("the run record did not survive the round trip");
	return parsed;
}

/** Eleven output deltas spread evenly over `spanMs`. */
function evenStream(clock: FakeClock, spanMs: number) {
	return (meter: Measurement) => {
		for (let i = 0; i <= 10; i++) {
			clock.t = 500 + (i * spanMs) / 10;
			meter.delta("text", "xxxxxxxxxx");
		}
	};
}

describe("request settlement and run aggregation agree after persistence (span just under one second)", () => {
	it.each([
		[999.49, false],
		[999.5, false],
		[999.99, false],
		[1000, true],
	])("a %f ms active span contributes to the run TPS: %s", (spanMs, contributes) => {
		const clock = new FakeClock();
		const run = persistedRun(clock, evenStream(clock, spanMs), 110);
		const request: RequestRecord | undefined = run.requests[0];
		expect(request?.outputTps !== undefined).toBe(contributes);
		expect(summarizeRun(run).tps !== undefined).toBe(contributes);
	});
});

describe("estimate provenance reaches the readout (estimated summary)", () => {
	it("marks a burst-only run whose tokens come from the estimate", () => {
		const clock = new FakeClock();
		const run = persistedRun(
			clock,
			(meter) => {
				clock.t = 4000;
				meter.delta("text", "x".repeat(900));
			},
			0,
		);
		expect(run.requests[0]).toMatchObject({ burst: true, estimated: true });
		const snapshot = { phase: "run" as const, run: summarizeRun(run) };
		expect(plainText(formatSnapshot(snapshot, "text", ""), "text")).toBe(
			"burst ~225.0 tok/s · TTFT 4.0s · 4.0s · in 10 · out ~900 · req 1",
		);
		expect(plainText(formatSnapshot(snapshot, "symbols", ""), "symbols")).toBe("✓ ↯~225.0/s ⇥4.0s 4.0s ↑10 ↓~900 ×1");
	});
});
