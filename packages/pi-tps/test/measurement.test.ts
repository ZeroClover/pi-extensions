import { beforeEach, describe, expect, it } from "vitest";
import { classifyBurst } from "../src/burst.ts";
import type { Clock } from "../src/clock.ts";
import type { DeltaEstimator, StreamKind } from "../src/estimator.ts";
import {
	type CalibrationSamples,
	type EndInput,
	type EndOutcome,
	Measurement,
	phaseEvent,
	type RequestContext,
	windowFigures,
} from "../src/measurement.ts";
import type { RequestRecord } from "../src/telemetry.ts";

class FakeClock implements Clock {
	t = 0;
	now(): number {
		return this.t;
	}
}

/** One raw token per character, so synthetic deltas carry exact token counts. */
class CharEstimator implements DeltaEstimator {
	calls = 0;
	add(_stream: StreamKind, delta: string): number {
		this.calls++;
		return delta.length;
	}
}

const CONTEXT: RequestContext = { provider: "p", model: "m", ratios: {}, wallTime: 1_700_000_000_000 };

function usage(output: number, extra: Partial<EndInput["usage"]> = {}): EndInput["usage"] {
	return { input: 100, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...extra };
}

function end(output: number, overrides: Partial<EndInput> = {}): EndInput {
	return { stopReason: "stop", provider: "p", model: "m", usage: usage(output), ...overrides };
}

function withReasoning(output: number, reasoning: number): EndInput {
	return end(output, { usage: usage(output, { reasoning }) });
}

function recorded(outcome: EndOutcome): { record: RequestRecord; calibration: CalibrationSamples } {
	if (outcome.kind !== "recorded") throw new Error(`expected a record, got ${outcome.kind}`);
	return outcome;
}

let clock: FakeClock;
let estimator: CharEstimator;
let meter: Measurement;

function start(context: Partial<RequestContext> = {}): void {
	meter.turnStart();
	expect(meter.requestStart({ ...CONTEXT, ...context })).toBe(true);
	meter.messageStart();
}

/** Emits `count` deltas of `tokens` tokens every `gapMs`, starting at `from`. Leaves the clock at the last delta. */
function stream(kind: StreamKind, from: number, count: number, gapMs: number, tokens: number): void {
	for (let i = 0; i < count; i++) {
		clock.t = from + i * gapMs;
		meter.delta(kind, "x".repeat(tokens));
	}
}

function at(time: number, action: () => void): void {
	clock.t = time;
	action();
}

const thinkingStart = () => meter.event({ type: "thinking_start" });
const thinkingEnd = () => meter.event({ type: "thinking_end" });
const outputStart = () => meter.event({ type: "output_start" });

function liveTpsAt(time: number): number | undefined {
	clock.t = time;
	return meter.snapshot()?.liveTps;
}

beforeEach(() => {
	clock = new FakeClock();
	estimator = new CharEstimator();
	meter = new Measurement(clock, () => estimator);
});

describe("phaseEvent", () => {
	it("maps phase boundaries and content deltas", () => {
		expect(phaseEvent({ type: "thinking_start" })).toEqual({ type: "thinking_start" });
		expect(phaseEvent({ type: "thinking_end" })).toEqual({ type: "thinking_end" });
		expect(phaseEvent({ type: "text_start" })).toEqual({ type: "output_start" });
		expect(phaseEvent({ type: "toolcall_start" })).toEqual({ type: "output_start" });
		expect(phaseEvent({ type: "thinking_delta", delta: "a" })).toEqual({
			type: "delta",
			stream: "thinking",
			text: "a",
		});
		expect(phaseEvent({ type: "text_delta", delta: "b" })).toEqual({ type: "delta", stream: "text", text: "b" });
		expect(phaseEvent({ type: "toolcall_delta", delta: "{" })).toEqual({
			type: "delta",
			stream: "toolcall",
			text: "{",
		});
	});

	it("ignores events that neither bound thinking nor carry content", () => {
		for (const type of ["start", "text_end", "toolcall_end", "done", "error"]) {
			expect(phaseEvent({ type })).toBeUndefined();
		}
		expect(phaseEvent({ type: "text_delta", delta: "" })).toBeUndefined();
		expect(phaseEvent({ type: "thinking_delta", delta: "" })).toBeUndefined();
	});
});

describe("request lifecycle", () => {
	it("ignores requests outside a turn (cache warming while idle)", () => {
		expect(meter.requestStart(CONTEXT)).toBe(false);
		expect(meter.snapshot()).toBeUndefined();
		expect(meter.end(end(10)).kind).toBe("ignored");
	});

	it("restarts at the last request of a retry, excluding the failed attempt from TTFT", () => {
		meter.turnStart();
		meter.requestStart(CONTEXT);
		clock.t = 2000;
		expect(meter.requestStart(CONTEXT)).toBe(true);
		meter.messageStart();
		clock.t = 2500;
		meter.delta("text", "hi");
		expect(meter.snapshot()?.ttftMs).toBe(500);
	});

	it("ignores a concurrent request once the stream started", () => {
		start();
		clock.t = 300;
		meter.delta("text", "hi");
		clock.t = 400;
		expect(meter.requestStart(CONTEXT)).toBe(false);
		expect(meter.snapshot()?.ttftMs).toBe(300);
	});

	it("ignores nested requests after the turn's assistant message ended", () => {
		start();
		meter.end(end(10));
		expect(meter.requestStart(CONTEXT)).toBe(false);
		meter.turnStart();
		expect(meter.requestStart(CONTEXT)).toBe(true);
	});

	it("drops an unfinished request at turn end and on reset", () => {
		start();
		expect(meter.turnEnd()).toBe(true);
		expect(meter.active).toBe(false);
		start();
		expect(meter.reset()).toBe(true);
		expect(meter.reset()).toBe(false);
	});

	it("switches to the serving model at message start without moving the timing origin (virtual model)", () => {
		meter.turnStart();
		meter.requestStart({ provider: "router", model: "auto", ratios: {}, wallTime: 1 });
		clock.t = 200;
		meter.messageStart({ provider: "anthropic", model: "claude-sonnet-4", ratios: { output: 1.3 } });
		stream("text", 500, 20, 100, 10);
		const snapshot = meter.snapshot();
		expect(snapshot).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4", calibrated: true, ttftMs: 500 });
		expect(snapshot?.outputTokens).toBeCloseTo(260);
	});

	it("reports waiting with a counting elapsed time before the first delta", () => {
		start();
		clock.t = 700;
		expect(meter.snapshot()).toMatchObject({ phase: "waiting", elapsedMs: 700, thinking: "none" });
		expect(meter.snapshot()?.ttftMs).toBeUndefined();
	});
});

describe("time to first token", () => {
	it("ends at the thinking start when its block streams (thinking arrives first)", () => {
		start();
		at(1100, thinkingStart);
		clock.t = 1200;
		expect(meter.snapshot()).toMatchObject({ phase: "streaming", elapsedMs: 1200 });
		expect(meter.snapshot()?.ttftMs).toBeUndefined();
		at(1300, () => meter.delta("thinking", "hmm"));
		expect(meter.snapshot()?.ttftMs).toBe(1100);
		stream("text", 1400, 20, 100, 5);
		expect(recorded(meter.end(end(500))).record.ttftMs).toBe(1100);
	});

	it("is not ended by a thinking block without deltas (thinking block without deltas)", () => {
		start();
		at(500, thinkingStart);
		at(8000, thinkingEnd);
		at(8200, () => meter.delta("text", "hello"));
		expect(meter.snapshot()?.ttftMs).toBe(8200);
		expect(recorded(meter.end(end(5))).record.ttftMs).toBe(8200);
	});

	it("is not ended by events without content (empty start events)", () => {
		start();
		at(400, outputStart);
		meter.delta("text", "");
		expect(meter.snapshot()?.phase).toBe("waiting");
		at(900, () => meter.delta("text", "hello"));
		expect(meter.snapshot()?.ttftMs).toBe(900);
	});

	it("records the time to the first visible text separately", () => {
		start();
		stream("thinking", 1000, 50, 100, 2);
		stream("text", 6000, 20, 100, 2);
		const { record } = recorded(meter.end(end(500)));
		expect(record.ttftMs).toBe(1000);
		expect(record.ttftTextMs).toBe(6000);
	});
});

describe("thinking phases", () => {
	it("measures 4 s of thinking and 2 s of text separately (mixed thinking and output)", () => {
		start();
		at(1000, thinkingStart);
		stream("thinking", 1000, 41, 100, 5);
		at(5000, thinkingEnd);
		stream("text", 5100, 21, 100, 5);
		const snapshot = meter.snapshot();
		expect(snapshot).toMatchObject({ thinkingMs: 4000, thinkingTokens: 205, outputTokens: 105, thinking: "streamed" });
		const { record } = recorded(meter.end(withReasoning(1000, 600)));
		expect(record).toMatchObject({ thinkingMs: 4000, thinkingTps: 150, outputTps: 200, generationMs: 6000 });
	});

	it("counts the silence between summary chunks as thinking (summary in chunks)", () => {
		start();
		at(1000, thinkingStart);
		for (const time of [2000, 6000, 11000]) at(time, () => meter.delta("thinking", "x".repeat(20)));
		at(12000, thinkingEnd);
		stream("text", 12100, 21, 100, 5);
		const { record } = recorded(meter.end(withReasoning(1600, 1500)));
		expect(record).toMatchObject({ thinkingMs: 11000, stallCount: 0, stallMs: 0, thinking: "streamed" });
	});

	it("times a block without deltas by its events (hidden reasoning)", () => {
		start();
		at(500, thinkingStart);
		clock.t = 3000;
		expect(meter.snapshot()).toMatchObject({ thinking: "hidden", thinkingMs: 2500 });
		expect(meter.snapshot()?.thinkingTokens).toBeUndefined();
		at(8000, thinkingEnd);
		stream("text", 8100, 31, 100, 5);
		const { record } = recorded(meter.end(withReasoning(1000, 850)));
		expect(record).toMatchObject({ thinkingMs: 7500, thinking: "hidden", thinkingTokens: 850 });
	});

	it("starts at the first chunk when the adapter synthesises the start (start synthesised from the first chunk)", () => {
		start();
		at(6000, () => {
			thinkingStart();
			meter.delta("thinking", "x".repeat(20));
		});
		for (const time of [8000, 10000]) at(time, () => meter.delta("thinking", "x".repeat(20)));
		at(12000, thinkingEnd);
		stream("text", 12100, 21, 100, 5);
		const { record } = recorded(meter.end(withReasoning(2000, 1900)));
		expect(record).toMatchObject({ thinkingMs: 6000, ttftMs: 6000, thinking: "streamed" });
	});

	it("sums several phases (several thinking phases)", () => {
		start();
		at(0, thinkingStart);
		stream("thinking", 0, 31, 100, 2);
		at(3000, outputStart);
		stream("toolcall", 3100, 5, 100, 2);
		at(4000, thinkingStart);
		stream("thinking", 4000, 21, 100, 2);
		at(6000, thinkingEnd);
		stream("text", 6100, 10, 100, 2);
		expect(recorded(meter.end(end(500))).record.thinkingMs).toBe(5000);
	});

	it("closes an orphan phase at the first non-thinking delta (phase without end event)", () => {
		start();
		stream("thinking", 1000, 31, 100, 2);
		at(4500, () => meter.delta("text", "hi"));
		expect(recorded(meter.end(end(80))).record.thinkingMs).toBe(3500);
	});

	it("closes an open phase at the end of the request", () => {
		start();
		at(1000, thinkingStart);
		clock.t = 3000;
		expect(recorded(meter.end(end(5))).record.thinkingMs).toBe(2000);
	});

	it("leaves thinking figures absent without thinking (no thinking)", () => {
		start();
		stream("text", 500, 30, 100, 3);
		expect(meter.snapshot()?.thinkingTokens).toBeUndefined();
		expect(meter.snapshot()?.thinkingMs).toBeUndefined();
		const { record } = recorded(meter.end(end(90)));
		expect(record.thinkingMs).toBeUndefined();
		expect(record.thinkingTokens).toBeUndefined();
		expect(record.thinkingTps).toBeUndefined();
		expect(record.thinking).toBe("none");
	});
});

describe("stall detection", () => {
	it("records a mid-stream pause and excludes it from the active span (server pause mid-stream)", () => {
		start();
		stream("text", 0, 11, 100, 10);
		stream("text", 2200, 11, 100, 10);
		const { record } = recorded(meter.end(end(220)));
		expect(record.stallCount).toBe(1);
		expect(record.stallMs).toBe(1200);
		expect(record.outputTps).toBe(110);
		expect(record.tps).toBe(110);
	});

	it("does not count the gap before the first delta", () => {
		start();
		stream("text", 3000, 20, 100, 5);
		const { record } = recorded(meter.end(end(100)));
		expect(record.stallCount).toBe(0);
		expect(record.ttftMs).toBe(3000);
	});

	it("counts consecutive stalled deltas as one stall", () => {
		start();
		stream("text", 0, 5, 100, 5);
		stream("text", 1000, 3, 600, 5);
		const { record } = recorded(meter.end(end(40)));
		expect(record.stallCount).toBe(1);
		expect(record.stallMs).toBe(600 + 600 + 600);
	});

	it("does not count silence inside a thinking phase (silence while thinking)", () => {
		start();
		at(0, () => meter.delta("thinking", "x".repeat(10)));
		at(4000, () => meter.delta("thinking", "x".repeat(10)));
		stream("text", 4100, 11, 100, 5);
		const { record } = recorded(meter.end(end(500)));
		expect(record.stallCount).toBe(0);
		expect(record.thinkingMs).toBe(4100);
	});

	it("does not count gaps around a phase change", () => {
		start();
		stream("text", 0, 11, 100, 5);
		at(1800, () => meter.delta("thinking", "x"));
		stream("text", 2600, 11, 100, 5);
		expect(recorded(meter.end(end(110))).record.stallCount).toBe(0);
	});
});

/** 5 s of thinking (`thinking_start` at 0, deltas of `tokens` every 500 ms) and 10 s of text with 8 tokens per delta. */
function thinkingThenText(tokens: number): void {
	at(0, thinkingStart);
	stream("thinking", 0, 11, 500, tokens);
	at(5000, thinkingEnd);
	stream("text", 5000, 101, 100, 8);
}

describe("settlement from provider usage", () => {
	it("counts every output token over the generation time (provider reports reasoning tokens)", () => {
		start();
		thinkingThenText(10);
		const { record } = recorded(meter.end(withReasoning(1200, 400)));
		expect(record).toMatchObject({
			tps: 80,
			generatedTokens: 1200,
			generationMs: 15_000,
			thinkingTokens: 400,
			outputTps: 80,
			estimated: false,
		});
	});

	it("estimates the thinking tokens when usage.reasoning is 0 (provider reports no reasoning breakdown)", () => {
		start({ ratios: { thinking: 0.5 } });
		thinkingThenText(70);
		const { record } = recorded(meter.end(withReasoning(1200, 0)));
		// 770 raw thinking tokens at ratio 0.5.
		expect(record).toMatchObject({ tps: 80, thinkingTokens: 385, outputTps: 81.5, estimated: false });
	});

	it("divides by the hidden phase as well (hidden thinking with reasoning count)", () => {
		start();
		at(0, thinkingStart);
		at(20_000, thinkingEnd);
		stream("text", 20_000, 31, 100, 10);
		const { record } = recorded(meter.end(withReasoning(1200, 900)));
		expect(record.tps).toBeCloseTo(52.17);
		expect(record).toMatchObject({ thinkingTokens: 900, thinkingTps: 45, thinking: "hidden" });
	});

	it("keeps a count without a phase as tokens without duration (reasoning count without a thinking phase)", () => {
		start();
		stream("text", 0, 31, 100, 10);
		const { record } = recorded(meter.end(withReasoning(1200, 900)));
		expect(record).toMatchObject({
			generatedTokens: 300,
			tps: 100,
			thinkingTokens: 900,
			outputTokens: 1200,
			estimated: false,
			burst: false,
		});
		expect(record.thinkingMs).toBeUndefined();
		expect(record.thinkingTps).toBeUndefined();
	});

	it("reports the visible-output rate without thinking (no thinking)", () => {
		start();
		stream("text", 0, 61, 100, 10);
		const { record } = recorded(meter.end(withReasoning(600, 0)));
		expect(record.tps).toBe(100);
		expect(record.thinkingTokens).toBeUndefined();
	});

	it("has no settled TPS under 1 s of generation time (very short response)", () => {
		start();
		at(0, thinkingStart);
		at(300, thinkingEnd);
		stream("text", 300, 5, 100, 5);
		const { record } = recorded(meter.end(end(25)));
		expect(record.generationMs).toBe(700);
		expect(record.burst).toBe(false);
		expect(record.tps).toBeUndefined();
	});

	it("rates a tool call over its thinking time (thinking-heavy tool call)", () => {
		start();
		at(0, thinkingStart);
		at(3000, thinkingEnd);
		stream("toolcall", 3000, 5, 100, 8);
		const { record } = recorded(meter.end(withReasoning(340, 300)));
		expect(record).toMatchObject({ generationMs: 3400, tps: 100, burst: false });
	});

	it("falls back to the calibrated estimate when usage.output is missing", () => {
		start({ ratios: { output: 2 } });
		stream("text", 0, 11, 100, 10);
		const outcome = recorded(meter.end(end(0)));
		expect(outcome.record).toMatchObject({ outputTokens: 220, outputTps: 220, tps: 220, estimated: true });
		expect(outcome.calibration).toEqual({});
	});

	it("produces an output sample from reported and estimated tokens", () => {
		start();
		stream("text", 0, 20, 100, 10);
		expect(recorded(meter.end(end(250))).calibration).toEqual({ output: { reported: 250, estimated: 200 } });
	});

	it("compares the total without a reasoning count", () => {
		start();
		stream("thinking", 0, 10, 100, 10);
		stream("text", 1000, 20, 100, 10);
		expect(recorded(meter.end(end(330))).calibration).toEqual({ output: { reported: 330, estimated: 300 } });
	});

	it("compares the total when reasoning is 0 after streamed thinking (reasoning reported as zero with streamed thinking)", () => {
		start();
		stream("thinking", 0, 10, 100, 50);
		stream("text", 1000, 25, 100, 10);
		expect(recorded(meter.end(withReasoning(900, 0))).calibration).toEqual({
			output: { reported: 900, estimated: 750 },
		});
	});

	it("samples visible output and thinking with a reasoning breakdown (reasoning breakdown)", () => {
		start();
		stream("thinking", 0, 5, 100, 20);
		stream("text", 1000, 25, 100, 10);
		expect(recorded(meter.end(withReasoning(900, 600))).calibration).toEqual({
			output: { reported: 300, estimated: 250 },
			thinking: { reported: 600, estimated: 100 },
		});
	});

	it("samples only the output when reasoning was hidden", () => {
		start();
		at(0, thinkingStart);
		at(1000, thinkingEnd);
		stream("text", 1000, 20, 100, 10);
		const outcome = recorded(meter.end(withReasoning(650, 400)));
		expect(outcome.calibration).toEqual({ output: { reported: 250, estimated: 200 } });
		expect(outcome.record.thinkingTokens).toBe(400);
	});
});

describe("inconsistent usage", () => {
	it("caps reasoning at the output and treats invalid counts as 0", () => {
		start();
		stream("text", 0, 20, 100, 10);
		const { record } = recorded(
			meter.end(end(300, { usage: usage(300, { reasoning: 500, input: -5, cacheRead: Number.NaN }) })),
		);
		expect(record.reasoningTokens).toBe(300);
		expect(record.thinkingTokens).toBe(300);
		expect(record.inputTokens).toBe(0);
		expect(record.cacheReadTokens).toBe(0);
	});
});

describe("burst requests", () => {
	it("mark a successful request without deltas and report its throughput", () => {
		start();
		clock.t = 2000;
		const { record } = recorded(meter.end(end(120)));
		expect(record.burstReason).toBe("few-batches");
		expect(record.throughputTps).toBe(60);
		expect(record.deltaCount).toBe(0);
	});

	it("treat a short response in few batches as too short to measure, not as burst", () => {
		start();
		stream("text", 500, 3, 100, 4);
		const { record } = recorded(meter.end(end(12)));
		expect(record.burst).toBe(false);
		expect(record.tps).toBeUndefined();
		expect(record.throughputTps).toBeUndefined();
	});

	it("report throughput for a response in one chunk", () => {
		start();
		clock.t = 4000;
		meter.delta("text", "x".repeat(900));
		const outcome = recorded(meter.end(end(900)));
		expect(outcome.record).toMatchObject({ burst: true, burstReason: "few-batches", throughputTps: 225 });
		expect(outcome.record.tps).toBeUndefined();
		expect(outcome.calibration).toEqual({});
	});

	it("mark a proxy flush after a long wait", () => {
		start();
		stream("text", 0, 10, 100, 5);
		stream("text", 6900, 10, 0.2, 10);
		expect(recorded(meter.end(end(150))).record.burstReason).toBe("cluster");
	});

	it("mark an implausible generation rate", () => {
		start();
		stream("text", 0, 11, 100, 5);
		const { record } = recorded(meter.end(end(25_000)));
		expect(record.burstReason).toBe("rate");
		expect(record.tps).toBeUndefined();
	});

	it("do not count hidden reasoning as output (hidden reasoning then a short tool call)", () => {
		start();
		at(0, thinkingStart);
		at(5000, thinkingEnd);
		for (const [time, tokens] of [
			[5100, 14],
			[5200, 13],
			[5300, 13],
		] as const) {
			at(time, () => meter.delta("toolcall", "x".repeat(tokens)));
		}
		expect(recorded(meter.end(withReasoning(940, 900))).record.burst).toBe(false);
	});

	it("subtract a reasoning count without a phase (reasoning count without a phase, short answer)", () => {
		start();
		stream("text", 0, 3, 200, 13);
		expect(recorded(meter.end(withReasoning(940, 900))).record.burst).toBe(false);
	});

	it("use the output stream's estimate after unreported thinking (short tool call after unreported thinking)", () => {
		start();
		at(0, thinkingStart);
		stream("thinking", 100, 20, 100, 25);
		at(2000, thinkingEnd);
		at(2100, () => meter.delta("toolcall", "x".repeat(20)));
		const outcome = recorded(meter.end(withReasoning(624, 0)));
		expect(outcome.record.burst).toBe(false);
		expect(outcome.record.tps).toBe(312);
		expect(outcome.calibration).toEqual({ output: { reported: 624, estimated: 520 } });
	});

	it("ignore summary chunks as burst evidence (chunked summary then a tool call)", () => {
		// The timeline from the review: with thinking deltas included, a three-chunk summary reads as burst.
		expect(classifyBurst({ at: [2000, 6000, 11000, 12000], tokens: [20, 20, 20, 20] }, 80)).toBe("few-batches");
		start();
		for (const time of [2000, 6000, 11000]) at(time, () => meter.delta("thinking", "x".repeat(20)));
		at(12000, () => meter.delta("toolcall", "x".repeat(20)));
		const outcome = recorded(meter.end(withReasoning(1500, 1480)));
		expect(outcome.record).toMatchObject({ burst: false, thinkingMs: 10_000, generationMs: 10_000, tps: 150 });
		expect(outcome.calibration.thinking).toEqual({ reported: 1480, estimated: 60 });
	});

	it("ignore a summary delivered in one piece", () => {
		start();
		at(8000, () => meter.delta("thinking", "x".repeat(300)));
		for (let i = 0; i < 80; i++) at(8050 + i * 50, () => meter.delta("text", "x".repeat(i % 2 === 0 ? 3 : 2)));
		expect(recorded(meter.end(withReasoning(500, 300))).record.burst).toBe(false);
	});

	it("catch a buffered chain of thought with its answer (buffered chain of thought and answer)", () => {
		start();
		at(15_000, () => {
			meter.delta("thinking", "x".repeat(1000));
			meter.delta("thinking", "x".repeat(1000));
			meter.delta("text", "x".repeat(200));
			meter.delta("text", "x".repeat(200));
		});
		const { record } = recorded(meter.end(withReasoning(2400, 0)));
		expect(record).toMatchObject({ burst: true, burstReason: "few-batches", throughputTps: 160 });
	});
});

describe("live generation rate", () => {
	it("is unavailable 0.8 s after the first output delta (early in the stream)", () => {
		start();
		stream("text", 1000, 9, 100, 5);
		expect(meter.snapshot()?.liveTps).toBeUndefined();
	});

	it("does not count the first chunk (first chunk is large)", () => {
		start();
		at(1000, () => meter.delta("text", "x".repeat(40)));
		for (let time = 1250; time <= 8000; time += 250) {
			at(time, () => meter.delta("text", "x".repeat(10)));
			const tps = meter.snapshot()?.liveTps;
			if (time - 1000 < 1500) expect(tps).toBeUndefined();
			else expect(tps).toBeCloseTo(40);
		}
	});

	it("uses the counted time when shorter than 5 s (window shorter than 5 s)", () => {
		start();
		stream("text", 1000, 31, 100, 5);
		expect(liveTpsAt(4000)).toBe(50);
	});

	it("uses the last 5 s at full length (window at full length)", () => {
		start();
		stream("text", 0, 201, 100, 8);
		expect(liveTpsAt(20_000)).toBeCloseTo(80);
	});

	it("prorates an interval straddling the window edge (delta straddling the window edge)", () => {
		const figures = windowFigures(
			{ at: [0, 1000], tokens: [5, 30], kinds: ["thinking", "thinking"], counted: [false, true] },
			600,
			() => 1,
		);
		expect(figures.tokens).toBeCloseTo(12);
		expect(figures.ms).toBeCloseTo(400);
	});

	it("excludes a pause from tokens and time (stall inside the window)", () => {
		start();
		stream("text", 0, 31, 100, 6);
		expect(liveTpsAt(5000)).toBeCloseTo(60);
	});

	it("keeps the rate while 1.5 s of output remain in the window (long pause)", () => {
		start();
		stream("text", 0, 101, 100, 6);
		expect(liveTpsAt(13_500)).toBeCloseTo(60);
		expect(liveTpsAt(13_600)).toBeUndefined();
		expect(liveTpsAt(20_000)).toBeUndefined();
	});

	describe("resuming after a pause", () => {
		const LAST = 10_000;

		/** Deltas of 15 tokens every 250 ms (60 tok/s) up to LAST, then after the pause the same up to `until`. */
		function pauseAndResume(pauseMs: number, until: number): void {
			start();
			stream("text", 0, LAST / 250 + 1, 250, 15);
			for (let time = LAST + pauseMs; time <= until; time += 250) at(time, () => meter.delta("text", "x".repeat(15)));
		}

		it("stays available throughout a 3 s pause", () => {
			pauseAndResume(3000, LAST);
			for (let time = LAST; time < LAST + 3000; time += 50) expect(liveTpsAt(time)).toBeDefined();
			for (let resumed = LAST + 3000; resumed <= LAST + 8000; resumed += 250) {
				at(resumed, () => meter.delta("text", "x".repeat(15)));
				expect(meter.snapshot()?.liveTps).toBeCloseTo(60);
				for (let offset = 50; offset < 250; offset += 50) expect(liveTpsAt(resumed + offset)).toBeDefined();
			}
		});

		it("returns after 1.5 s of resumed output after a 4 s pause", () => {
			for (const [now, available] of [
				[LAST + 4500, false],
				[LAST + 5000, false],
				[LAST + 5250, false],
				[LAST + 5500, true],
			] as const) {
				clock.t = 0;
				pauseAndResume(4000, now);
				const tps = liveTpsAt(now);
				if (available) expect(tps).toBeCloseTo(60);
				else expect(tps).toBeUndefined();
			}
		});

		it("clips every interval with the sliding window (counted time 1.0 s at 4.5 s and 5.0 s)", () => {
			const at: number[] = [];
			for (let time = 0; time <= LAST; time += 250) at.push(time);
			for (let time = LAST + 4000; time <= LAST + 5000; time += 250) at.push(time);
			const timeline = {
				at,
				tokens: at.map(() => 15),
				kinds: at.map(() => "output" as const),
				counted: at.map((time) => time !== 0 && time !== LAST + 4000),
			};
			const msAt = (now: number) => {
				const delivered = at.filter((time) => time <= now);
				const view = {
					at: delivered,
					tokens: timeline.tokens.slice(0, delivered.length),
					kinds: timeline.kinds.slice(0, delivered.length),
					counted: timeline.counted.slice(0, delivered.length),
				};
				const trailing = now - (delivered.at(-1) ?? now);
				return windowFigures(view, now - 5000, () => 1).ms + (trailing < 500 ? trailing : 0);
			};
			expect(msAt(LAST + 4500)).toBeCloseTo(1000);
			expect(msAt(LAST + 5000)).toBeCloseTo(1000);
		});
	});

	it("counts calibrated thinking tokens (thinking phase)", () => {
		start({ ratios: { thinking: 8 } });
		at(0, thinkingStart);
		for (let time = 0; time <= 6000; time += 1000) {
			at(time, () => meter.delta("thinking", "x".repeat(20)));
			const tps = meter.snapshot()?.liveTps;
			if (time < 2000) expect(tps).toBeUndefined();
			else expect(tps).toBeCloseTo(160);
		}
	});

	it("is unavailable while a phase without deltas is open (hidden thinking phase)", () => {
		start();
		stream("text", 0, 31, 100, 6);
		at(3000, thinkingStart);
		clock.t = 4000;
		expect(meter.snapshot()).toMatchObject({ thinking: "hidden", thinkingMs: 1000 });
		expect(meter.snapshot()?.liveTps).toBeUndefined();
	});

	it("applies the output ratio (calibrated model)", () => {
		start({ ratios: { output: 1.2 } });
		stream("text", 0, 21, 100, 5);
		const snapshot = meter.snapshot();
		expect(snapshot).toMatchObject({ calibrated: true, tpsCalibrated: true });
		expect(snapshot?.outputTokens).toBeCloseTo(126);
		// 100 raw tokens in the window, 120 calibrated, over 2 s.
		expect(snapshot?.liveTps).toBeCloseTo(60);
	});

	it("marks the TPS while uncalibrated thinking tokens are in the window (output calibrated, thinking not)", () => {
		start({ ratios: { output: 1 } });
		stream("thinking", 0, 21, 100, 5);
		expect(meter.snapshot()).toMatchObject({ calibrated: true, thinkingCalibrated: false, tpsCalibrated: false });
		stream("text", 2100, 80, 100, 5);
		expect(meter.snapshot()).toMatchObject({ calibrated: true, thinkingCalibrated: false, tpsCalibrated: true });
	});

	it("marks figures of an uncalibrated model", () => {
		start();
		expect(meter.snapshot()).toMatchObject({ calibrated: false, thinkingCalibrated: false });
	});

	it("counts only arriving tokens, not estimator corrections", () => {
		const increments = [...Array.from({ length: 20 }, () => 10), -50];
		meter = new Measurement(clock, () => ({ add: () => increments.shift() ?? 0 }));
		start();
		stream("text", 0, 21, 100, 1);
		expect(meter.snapshot()?.liveTps).toBeCloseTo(95);
	});

	it("does not re-estimate earlier deltas (long stream)", () => {
		start();
		stream("text", 0, 5000, 10, 1);
		expect(estimator.calls).toBe(5000);
		meter.snapshot();
		expect(estimator.calls).toBe(5000);
		expect(meter.snapshot()?.liveTps).toBeCloseTo(100);
	});

	it("merges deltas of one network read into one arrival", () => {
		start();
		at(0, () => meter.delta("text", "x".repeat(10)));
		for (let time = 100; time <= 2000; time += 100) {
			at(time, () => {
				meter.delta("text", "x".repeat(3));
				meter.delta("text", "x".repeat(2));
			});
		}
		expect(meter.snapshot()?.liveTps).toBeCloseTo(50);
	});
});

describe("aborted, errored and deferred requests", () => {
	it("produce a partial aborted record without calibration", () => {
		start();
		stream("text", 500, 46, 100, 5);
		clock.t = 5500;
		const outcome = recorded(meter.end(end(0, { stopReason: "aborted" })));
		expect(outcome.record).toMatchObject({
			outcome: "aborted",
			burst: false,
			outputTokens: 230,
			outputTps: 51.11,
			tps: 51.11,
			elapsedMs: 5500,
		});
		expect(outcome.calibration).toEqual({});
	});

	it.each(["error", "deferred"])("produce no record for %s", (stopReason) => {
		start();
		stream("text", 0, 10, 100, 5);
		expect(meter.end(end(50, { stopReason })).kind).toBe("errored");
		expect(meter.active).toBe(false);
	});
});

describe("elapsed time and cost", () => {
	it("omits cost for unpriced models and records usage tokens", () => {
		start();
		stream("text", 0, 20, 100, 5);
		clock.t = 2500;
		const { record } = recorded(
			meter.end(end(100, { usage: usage(100, { input: 12_345, cacheRead: 800, cacheWrite: 20 }) })),
		);
		expect(record.cost).toBeUndefined();
		expect(record.elapsedMs).toBe(2500);
		expect(record).toMatchObject({
			inputTokens: 12_345,
			outputTokens: 100,
			cacheReadTokens: 800,
			cacheWriteTokens: 20,
			deltaCount: 20,
		});
	});

	it("carries the cost of priced models", () => {
		start();
		stream("text", 0, 20, 100, 5);
		const { record } = recorded(meter.end(end(100, { usage: usage(100, { cost: { total: 0.0123 } }) })));
		expect(record.cost).toBe(0.0123);
	});

	it("records the time to response headers", () => {
		start();
		clock.t = 350;
		meter.responseHeaders();
		stream("text", 600, 10, 100, 5);
		expect(recorded(meter.end(end(50))).record.headersMs).toBe(350);
	});

	it("records a clock skew above 250 ms against durationMs", () => {
		start();
		stream("text", 0, 20, 100, 5);
		clock.t = 2000;
		expect(recorded(meter.end(end(100, { durationMs: 2100 }))).record.clockSkewMs).toBeUndefined();
		clock.t = 0;
		start();
		stream("text", 0, 20, 100, 5);
		clock.t = 2000;
		expect(recorded(meter.end(end(100, { durationMs: 2600 }))).record.clockSkewMs).toBe(600);
	});

	it("records the wall-clock request time and the response model", () => {
		start();
		stream("text", 0, 20, 100, 5);
		const { record } = recorded(meter.end(end(100, { responseModel: "m-2025" })));
		expect(record.timestamp).toBe(CONTEXT.wallTime);
		expect(record.responseModel).toBe("m-2025");
	});
});
