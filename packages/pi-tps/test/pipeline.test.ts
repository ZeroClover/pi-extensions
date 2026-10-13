import { describe, expect, it } from "vitest";
import { summarizeRun, summarizeSession } from "../src/aggregate.ts";
import { largestClusterShare } from "../src/burst.ts";
import { CALIBRATION_KINDS, CalibrationStore } from "../src/calibration.ts";
import type { Clock } from "../src/clock.ts";
import { createDeltaEstimator } from "../src/estimator.ts";
import type { FileLayer } from "../src/files.ts";
import { formatSnapshot, formatTps, plainText } from "../src/format.ts";
import { type AssistantEventLike, type EndInput, Measurement, phaseEvent } from "../src/measurement.ts";
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
	meter.requestStart({ provider: "p", model: "m", ratios: {}, wallTime: 1 });
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
		expect(request?.tps !== undefined).toBe(contributes);
		expect(summarizeRun(run).tps !== undefined).toBe(contributes);
	});
});

describe("a request, its run and a one-run session show the same rate (non-integer generation time)", () => {
	/** A hidden thinking phase from 0 to `thinkingEndAt`, then one 10-token tool-call delta; output 100, reasoning 90. */
	function hiddenThenToolCall(thinkingEndAt: number, toolCallAt: number) {
		const clock = new FakeClock();
		const meter = new Measurement(clock, () => ({ add: (_stream, delta) => delta.length }));
		const tracker = new RunTracker(clock);
		tracker.start(1);
		meter.turnStart();
		meter.requestStart({ provider: "p", model: "m", ratios: {}, wallTime: 1 });
		meter.messageStart();
		meter.event({ type: "thinking_start" });
		clock.t = thinkingEndAt;
		meter.event({ type: "thinking_end" });
		clock.t = toolCallAt;
		meter.event({ type: "delta", stream: "toolcall", text: "x".repeat(10) });
		const outcome = meter.end({
			stopReason: "toolUse",
			provider: "p",
			model: "m",
			usage: { input: 10, output: 100, reasoning: 90, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		});
		if (outcome.kind !== "recorded") throw new Error(`expected a record, got ${outcome.kind}`);
		tracker.add(outcome.record);
		const run = parseRunRecord(JSON.parse(JSON.stringify(tracker.settle(false))));
		if (!run) throw new Error("the run record did not survive the round trip");
		const session = summarizeSession([run]);
		return { request: outcome.record.tps, run: summarizeRun(run).tps, session: session?.tps };
	}

	it.each([
		// 100 tokens over 1000.9 ms: 99.91 tok/s, which rounding the time down to 1000 ms would show as 100.0.
		[1000.9, 1001],
		// 100 tokens over 1000.5043 ms: 99.9496 tok/s, which rounding the rate to two decimals would show as 100.0.
		[1000.5043, 1000.5043],
	])("thinking until %f ms, tool call at %f ms", (thinkingEndAt, toolCallAt) => {
		const rates = hiddenThenToolCall(thinkingEndAt, toolCallAt);
		expect(rates.request).toBeDefined();
		expect(rates.run).toBe(rates.request);
		expect(rates.session).toBe(rates.request);
		expect(formatTps(rates.run ?? 0)).toBe("99.9");
	});

	it("keeps a generation time just under one second out after persistence", () => {
		expect(hiddenThenToolCall(999.6, 999.6)).toEqual({ request: undefined, run: undefined, session: undefined });
	});
});

describe("estimator corrections are not token arrivals (estimator correction at the end)", () => {
	function settleWithRealEstimator(deltas: string[], output: number): RunRecord {
		const clock = new FakeClock();
		const meter = new Measurement(clock, createDeltaEstimator);
		const run = new RunTracker(clock);
		run.start(1);
		meter.turnStart();
		meter.requestStart({ provider: "p", model: "m", ratios: {}, wallTime: 1 });
		meter.messageStart();
		deltas.forEach((delta, i) => {
			clock.t = 500 + i * 300;
			meter.delta("text", delta);
		});
		const outcome = meter.end(end(output));
		if (outcome.kind !== "recorded") throw new Error(`expected a record, got ${outcome.kind}`);
		run.add(outcome.record);
		const record = run.settle(false);
		if (!record) throw new Error("no run");
		return record;
	}

	it("does not mark evenly arriving deltas as burst when the last one lowers the estimate", () => {
		const run = settleWithRealEstimator(["123456", "789012", "345678", "90", "n"], 30);
		expect(run.requests[0]).toMatchObject({ burst: false, outputMs: 1200, outputTps: 25, tps: 25 });
		expect(summarizeRun(run).tps).toBe(25);
	});

	it("keeps the cluster share a share of arriving tokens, at most 100 %", () => {
		// The real estimator's increments for these deltas are 7, -4, 0, 1, 0; only the positive parts arrive.
		const estimator = createDeltaEstimator();
		const increments = ["12345678901234567890", "n", " ", "a", "b"].map((delta) => estimator.add("text", delta));
		expect(increments.some((increment) => increment < 0)).toBe(true);
		const tokens = increments.map((increment) => Math.max(0, increment));
		expect(largestClusterShare({ at: [0, 300, 600, 900, 1200], tokens })).toBeLessThanOrEqual(1);
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

/** An in-memory calibration directory. */
function memoryFiles(): FileLayer {
	const files = new Map<string, string>();
	return {
		read: (path) => files.get(path),
		list: (dir) =>
			[...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
		publish: (path, content) => {
			if (files.has(path)) return false;
			files.set(path, content);
			return true;
		},
		remove: (path) => {
			files.delete(path);
		},
	};
}

interface RequestScript {
	/** Assistant message events with their time relative to the request start. */
	events: [number, AssistantEventLike][];
	endAt: number;
	output: number;
	reasoning?: number;
}

const thinkingStart = (at: number): [number, AssistantEventLike] => [at, { type: "thinking_start" }];
const thinkingEnd = (at: number): [number, AssistantEventLike] => [at, { type: "thinking_end" }];
const textStart = (at: number): [number, AssistantEventLike] => [at, { type: "text_start" }];
const toolcallStart = (at: number): [number, AssistantEventLike] => [at, { type: "toolcall_start" }];

function deltas(
	type: string,
	from: number,
	count: number,
	gapMs: number,
	tokens: number,
): [number, AssistantEventLike][] {
	return Array.from({ length: count }, (_, i) => [from + i * gapMs, { type, delta: "x".repeat(tokens) }]);
}

/**
 * Feeds the requests of one run through the whole pipeline: phase events, measurement, burst detection, the run
 * tracker, calibration, persistence and the summaries. One raw token per character.
 */
function runPipeline(requests: RequestScript[]) {
	const clock = new FakeClock();
	const meter = new Measurement(clock, () => ({ add: (_stream, delta) => delta.length }));
	const tracker = new RunTracker(clock);
	const calibration = new CalibrationStore("/agent/pi-tps-calibration", memoryFiles(), () => 0);
	calibration.load();
	tracker.start(1);
	let base = 0;
	for (const script of requests) {
		clock.t = base;
		meter.turnStart();
		meter.requestStart({ provider: "p", model: "m", ratios: calibration.ratios("p/m"), wallTime: 1 });
		meter.messageStart();
		for (const [time, event] of script.events) {
			clock.t = base + time;
			const phase = phaseEvent(event);
			if (phase) meter.event(phase);
		}
		clock.t = base + script.endAt;
		const outcome = meter.end({
			stopReason: "stop",
			provider: "p",
			model: "m",
			usage: {
				input: 10,
				output: script.output,
				reasoning: script.reasoning,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		});
		if (outcome.kind !== "recorded") throw new Error(`expected a record, got ${outcome.kind}`);
		tracker.add(outcome.record);
		for (const kind of CALIBRATION_KINDS) {
			const sample = outcome.calibration[kind];
			if (sample) calibration.update("p/m", kind, sample, 0);
		}
		base = clock.t;
	}
	const parsed = parseRunRecord(JSON.parse(JSON.stringify(tracker.settle(false))));
	if (!parsed) throw new Error("the run record did not survive the round trip");
	const run = summarizeRun(parsed);
	const session = summarizeSession([parsed]);
	if (!session) throw new Error("no session");
	return {
		records: parsed.requests,
		run,
		session,
		ratios: calibration.ratios("p/m"),
		summary: plainText(formatSnapshot({ phase: "run", run }, "text", ""), "text"),
		sessionLine: plainText(formatSnapshot({ phase: "session", session }, "text", ""), "text"),
	};
}

describe("thinking models end to end", () => {
	it("full chain of thought reported with reasoning 0", () => {
		const result = runPipeline([
			{
				events: [
					thinkingStart(500),
					...deltas("thinking_delta", 500, 41, 100, 10),
					thinkingEnd(4500),
					textStart(4500),
					...deltas("text_delta", 4600, 51, 100, 8),
				],
				endAt: 10_000,
				output: 820,
				reasoning: 0,
			},
		]);
		expect(result.records[0]).toMatchObject({ thinking: "streamed", thinkingMs: 4000, outputMs: 5000, burst: false });
		expect(result.summary).toBe("TPS 91.1 tok/s · TTFT 0.5s · 10.0s · in 10 · out ~410 · think ~410 4.0s · req 1");
		expect(result.sessionLine).toBe("session · TPS 91.1 tok/s · TTFT 0.5s · in 10 · out ~410 · runs 1");
		// The request, its run and a one-run session show the same rate.
		expect(result.run.tps).toBeCloseTo(result.records[0]?.tps ?? 0, 1);
		expect(result.session.tps).toBe(result.run.tps);
		// The output ratio compares the total; no thinking ratio without a reasoning count.
		expect(result.ratios.output).toBeCloseTo(820 / 818);
		expect(result.ratios.thinking).toBeUndefined();
	});

	it("Responses-style hidden reasoning", () => {
		const result = runPipeline([
			{
				events: [thinkingStart(300), thinkingEnd(6300), textStart(6300), ...deltas("text_delta", 6400, 31, 100, 10)],
				endAt: 10_000,
				output: 1210,
				reasoning: 900,
			},
		]);
		expect(result.records[0]).toMatchObject({ thinking: "hidden", thinkingMs: 6000, burst: false });
		expect(result.summary).toBe("TPS 134.4 tok/s · TTFT 6.4s · 10.0s · in 10 · out 310 · think 900 6.0s · req 1");
		expect(result.session.tps).toBe(result.run.tps);
		expect(result.ratios).toEqual({ output: 1, thinking: undefined });
	});

	it("chunked summary with a reasoning count, then a short tool call and the answer", () => {
		const result = runPipeline([
			{
				events: [
					thinkingStart(1000),
					...[2000, 6000, 11000].map((at): [number, AssistantEventLike] => [
						at,
						{ type: "thinking_delta", delta: "x".repeat(20) },
					]),
					thinkingEnd(12000),
					toolcallStart(12000),
					[12100, { type: "toolcall_delta", delta: "x".repeat(20) }],
				],
				endAt: 12_200,
				output: 1500,
				reasoning: 1480,
			},
			{ events: [textStart(400), ...deltas("text_delta", 500, 21, 100, 10)], endAt: 2600, output: 210 },
		]);
		const [toolCall] = result.records;
		expect(toolCall).toMatchObject({ burst: false, thinkingMs: 11_000, generationMs: 11_000 });
		expect(toolCall?.tps).toBeCloseTo(136.36);
		// The tool call contributes: the answer alone would rate 105.
		expect(result.run.tps).toBeCloseTo(1710 / 13);
		expect(result.summary).toBe("TPS 131.5 tok/s · TTFT 0.8s · 14.8s · in 20 · out 230 · think 1.5K 11.0s · req 2");
		expect(result.ratios.thinking).toBeCloseTo(1480 / 60);
	});

	it("a reasoning count without a phase mixed with a thinking request", () => {
		const result = runPipeline([
			{
				events: [textStart(400), ...deltas("text_delta", 500, 31, 100, 10)],
				endAt: 3600,
				output: 1210,
				reasoning: 900,
			},
			{
				events: [
					thinkingStart(0),
					...deltas("thinking_delta", 0, 11, 500, 10),
					thinkingEnd(5000),
					...deltas("text_delta", 5000, 101, 100, 8),
				],
				endAt: 15_100,
				output: 1200,
				reasoning: 400,
			},
		]);
		expect(result.records[0]).toMatchObject({ thinking: "none", generatedTokens: 310 });
		expect(result.records[0]?.tps).toBeCloseTo(310 / 3);
		expect(result.run.tps).toBeCloseTo(1510 / 18);
		expect(result.session.tps).toBe(result.run.tps);
		expect(result.summary).toBe("TPS 83.9 tok/s · TTFT 0.3s · 18.7s · in 20 · out 1.1K · think 1.3K 5.0s · req 2");
	});
});
