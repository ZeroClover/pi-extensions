import { describe, expect, it } from "vitest";
import { sessionTotals } from "../src/aggregate.ts";
import { ModelAverages } from "../src/averages.ts";
import { largestClusterShare } from "../src/burst.ts";
import { CALIBRATION_KINDS, CalibrationStore } from "../src/calibration.ts";
import type { Clock } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { createDeltaEstimator } from "../src/estimator.ts";
import type { FileLayer } from "../src/files.ts";
import { formatSnapshot, formatTps, plainText } from "../src/format.ts";
import { type AssistantEventLike, type EndInput, Measurement, phaseEvent } from "../src/measurement.ts";
import { RunTracker } from "../src/run.ts";
import { parseRunRecord, type RequestRecord, type RunRecord, type StatusSnapshot } from "../src/telemetry.ts";

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

const METRICS = { tps: defaultConfig().tps, ttft: defaultConfig().ttft };

/** The averages of `p/m` replayed from the runs, as a session start rebuilds them. */
function averagesOf(runs: readonly RunRecord[]) {
	const averages = new ModelAverages();
	averages.rebuild(runs.flatMap((run) => run.requests));
	return averages.of("p", "m");
}

/** The idle readout of a branch holding these runs, with `p/m` as the current model. */
function idleLine(runs: readonly RunRecord[]): string {
	const session = sessionTotals(runs);
	const snapshot: StatusSnapshot = session
		? { phase: "idle", average: averagesOf(runs), session }
		: { phase: "idle", average: {} };
	return plainText(formatSnapshot(snapshot, "", METRICS));
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

describe("request settlement and the TPS average agree after persistence (span just under one second)", () => {
	// Without thinking the first 300 ms after the first delta do not count, so 1.3 s of span is 1 s of counted time.
	it.each([
		[1299.49, false],
		[1299.5, false],
		[1299.99, false],
		[1300, true],
	])("a %f ms active span contributes to the model's TPS average: %s", (spanMs, contributes) => {
		const clock = new FakeClock();
		const run = persistedRun(clock, evenStream(clock, spanMs), 110);
		const request: RequestRecord | undefined = run.requests[0];
		expect(request?.tps !== undefined).toBe(contributes);
		expect(averagesOf([run]).tps !== undefined).toBe(contributes);
	});
});

describe("a request and the average of a model with one request show the same rate (non-integer generation time)", () => {
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
		return { request: outcome.record.tps, average: averagesOf([run]).tps };
	}

	it.each([
		// 100 tokens over 1000.9 ms: 99.91 tok/s, which rounding the time down to 1000 ms would show as 100.0.
		[1000.9, 1001],
		// 100 tokens over 1000.5043 ms: 99.9496 tok/s, which rounding the rate to two decimals would show as 100.0.
		[1000.5043, 1000.5043],
	])("thinking until %f ms, tool call at %f ms", (thinkingEndAt, toolCallAt) => {
		const rates = hiddenThenToolCall(thinkingEndAt, toolCallAt);
		expect(rates.request).toBeDefined();
		expect(rates.average).toBe(rates.request);
		expect(formatTps(rates.average ?? 0)).toBe("99.9");
	});

	it("keeps a generation time just under one second out after persistence", () => {
		expect(hiddenThenToolCall(999.6, 999.6)).toEqual({ request: undefined, average: undefined });
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
		// Increments 2, 2, 2, 2, 1, -5: 5 of the 9 arriving tokens count, over 1.2 s.
		const run = settleWithRealEstimator(["123456", "789012", "345678", "901234", "56", "n"], 54);
		expect(run.requests[0]).toMatchObject({ burst: false, outputMs: 1500, outputTps: 36, generatedTokens: 30 });
		expect(run.requests[0]?.tps).toBeCloseTo(25);
		expect(averagesOf([run]).tps).toBe(run.requests[0]?.tps);
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

describe("an estimated burst reaches the idle readout without a marker (uncalibrated estimate)", () => {
	it("shows the burst average of a run whose tokens come from the estimate", () => {
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
		expect(idleLine([run])).toBe("✓ x̄↯225.0 TPS | TTFT x̄4.0s | 1 run in 4.0s | 1➤ | ↑10 | ↓900");
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
 * tracker, calibration, persistence, the averages and the session totals. One raw token per character.
 */
function runPipeline(requests: RequestScript[]) {
	const clock = new FakeClock();
	const meter = new Measurement(clock, () => ({ add: (_stream, delta) => delta.length }));
	const tracker = new RunTracker(clock);
	const calibration = new CalibrationStore("/agent/pi-tps-calibration", memoryFiles(), () => 0);
	calibration.load();
	tracker.start(1);
	/** Live TPS of each request, sampled right after each of its output deltas. */
	const live: (number | undefined)[][] = [];
	let base = 0;
	for (const script of requests) {
		const samples: (number | undefined)[] = [];
		live.push(samples);
		clock.t = base;
		meter.turnStart();
		meter.requestStart({ provider: "p", model: "m", ratios: calibration.ratios("p/m"), wallTime: 1 });
		meter.messageStart();
		for (const [time, event] of script.events) {
			clock.t = base + time;
			const phase = phaseEvent(event);
			if (!phase) continue;
			meter.event(phase);
			if (phase.type === "delta" && phase.stream !== "thinking") samples.push(meter.snapshot()?.liveTps);
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
	return {
		live,
		records: parsed.requests,
		average: averagesOf([parsed]),
		ratios: calibration.ratios("p/m"),
		idle: idleLine([parsed]),
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
		expect(result.idle).toBe("✓ x̄91.1 TPS | TTFT x̄0.5s | 1 run in 10.0s | 1➤ | ↑10 | ↓410 | ⠿410");
		// The first sample is the average.
		expect(result.average.tps).toBe(result.records[0]?.tps);
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
		expect(result.idle).toBe("✓ x̄134.4 TPS | TTFT x̄6.4s | 1 run in 10.0s | 1➤ | ↑10 | ↓310 | ⠿900");
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
		// The tool call contributes a sample of its own next to the answer's 100 (170 counted tokens over 1.7 s).
		expect(result.records[1]?.tps).toBeCloseTo(100);
		expect(result.average.tps).toBeCloseTo((1500 / 11 + 100) / 2);
		expect(result.idle).toBe("✓ x̄118.2 TPS | TTFT x̄0.8s | 1 run in 14.8s | 2➤ | ↑20 | ↓230 | ⠿1.5K");
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
		expect(result.records[0]).toMatchObject({ thinking: "none", generatedTokens: 270, generationMs: 2700 });
		expect(result.records[0]?.tps).toBeCloseTo(100);
		expect(result.records[1]?.tps).toBeCloseTo(80);
		expect(result.average.tps).toBeCloseTo((100 + 80) / 2);
		// The second request's thinking started with the request, a TTFT of 0 that the average ignores.
		expect(result.records[1]?.ttftMs).toBe(0);
		expect(result.idle).toBe("✓ x̄90.0 TPS | TTFT x̄0.5s | 1 run in 18.7s | 2➤ | ↑20 | ↓1.1K | ⠿1.3K");
	});
});

describe("the backlog after hidden or summarised thinking (measured post-thinking delivery)", () => {
	/** Output deltas of 15 tokens, 0.2 ms apart, starting at `from`; `gapAfter` widens one gap to 1.5 ms. */
	function read(from: number, count: number, gapAfter?: number): [number, AssistantEventLike][] {
		const events: [number, AssistantEventLike][] = [];
		let time = from;
		for (let i = 0; i < count; i++) {
			events.push([time, { type: "text_delta", delta: "x".repeat(15) }]);
			time += i === gapAfter ? 1.5 : 0.2;
		}
		return events;
	}

	it("replays without a live peak, a burst, or a lowered settled rate", () => {
		const result = runPipeline([
			{
				events: [
					thinkingStart(0),
					// One summary read: eight deltas handed over at the same time.
					...deltas("thinking_delta", 900, 8, 0, 10),
					thinkingEnd(6500),
					textStart(6500),
					...read(6500, 96, 60),
					...read(6525, 13),
					...read(6638, 20),
					...deltas("text_delta", 6700, 29, 100, 15),
				],
				endAt: 9600,
				output: 2500,
			},
		]);
		const samples = result.live[0] ?? [];
		const first = samples.findIndex((tps) => tps !== undefined);
		expect(first).toBeGreaterThan(0);
		for (const tps of samples.slice(first)) {
			expect(tps).toBeDefined();
			expect(tps ?? 0).toBeLessThanOrEqual(1.2 * 150);
		}
		const [request] = result.records;
		expect(request).toMatchObject({ burst: false, thinkingMs: 6500 });
		expect(request?.tps).toBeCloseTo(2500 / 9.5);
	});
});
