import { beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.ts";
import type { DeltaEstimator, StreamKind } from "../src/estimator.ts";
import { contentDelta, type EndInput, type EndOutcome, Measurement, type RequestContext } from "../src/measurement.ts";
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

const CONTEXT: RequestContext = { provider: "p", model: "m", wallTime: 1_700_000_000_000 };

function usage(output: number, extra: Partial<EndInput["usage"]> = {}): EndInput["usage"] {
	return { input: 100, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...extra };
}

function end(output: number, overrides: Partial<EndInput> = {}): EndInput {
	return { stopReason: "stop", provider: "p", model: "m", usage: usage(output), ...overrides };
}

function recorded(outcome: EndOutcome): { record: RequestRecord; calibration?: unknown } {
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

beforeEach(() => {
	clock = new FakeClock();
	estimator = new CharEstimator();
	meter = new Measurement(clock, () => estimator);
});

describe("contentDelta", () => {
	it("maps content deltas to streams", () => {
		expect(contentDelta({ type: "thinking_delta", delta: "a" })).toEqual({ stream: "thinking", text: "a" });
		expect(contentDelta({ type: "text_delta", delta: "b" })).toEqual({ stream: "text", text: "b" });
		expect(contentDelta({ type: "toolcall_delta", delta: "{" })).toEqual({ stream: "toolcall", text: "{" });
	});

	it("ignores events without content", () => {
		expect(contentDelta({ type: "text_start" })).toBeUndefined();
		expect(contentDelta({ type: "start" })).toBeUndefined();
		expect(contentDelta({ type: "text_delta", delta: "" })).toBeUndefined();
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
		meter.requestStart({ provider: "router", model: "auto", wallTime: 1 });
		clock.t = 200;
		meter.messageStart({ provider: "anthropic", model: "claude-sonnet-4", ratio: 1.3 });
		stream("text", 500, 20, 100, 10);
		const snapshot = meter.snapshot();
		expect(snapshot).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4", calibrated: true, ttftMs: 500 });
		expect(snapshot?.outputTokens).toBeCloseTo(260);
	});

	it("reports waiting with a counting elapsed time before the first delta", () => {
		start();
		clock.t = 700;
		expect(meter.snapshot()).toMatchObject({ phase: "waiting", elapsedMs: 700 });
		expect(meter.snapshot()?.ttftMs).toBeUndefined();
	});
});

describe("time to first token", () => {
	it("ends at the first thinking delta", () => {
		start();
		clock.t = 1300;
		meter.delta("thinking", "hmm");
		expect(meter.snapshot()).toMatchObject({ phase: "streaming", ttftMs: 1300 });
	});

	it("is not ended by events without content", () => {
		start();
		clock.t = 400;
		const startEvent = contentDelta({ type: "text_start" });
		expect(startEvent).toBeUndefined();
		meter.delta("text", "");
		clock.t = 900;
		meter.delta("text", "hello");
		expect(meter.snapshot()?.ttftMs).toBe(900);
	});
});

describe("time to first visible text", () => {
	it("is recorded separately when thinking precedes text", () => {
		start();
		stream("thinking", 1000, 50, 100, 2);
		stream("text", 6000, 20, 100, 2);
		const { record } = recorded(meter.end(end(500)));
		expect(record.ttftMs).toBe(1000);
		expect(record.ttftTextMs).toBe(6000);
	});
});

describe("thinking and output", () => {
	it("measures 4 s of thinking and 2 s of text separately", () => {
		start();
		stream("thinking", 1000, 41, 100, 5);
		stream("text", 5100, 21, 100, 5);
		const snapshot = meter.snapshot();
		expect(snapshot?.thinkingMs).toBe(4000);
		expect(snapshot?.thinkingTokens).toBe(205);
		expect(snapshot?.outputTokens).toBe(105);
		const { record } = recorded(meter.end(end(1000, { usage: usage(1000, { reasoning: 600 }) })));
		expect(record.thinkingMs).toBe(4000);
		expect(record.thinkingTps).toBe(150);
		expect(record.outputTps).toBe(200);
	});

	it("leaves thinking figures absent without thinking", () => {
		start();
		stream("text", 500, 30, 100, 3);
		expect(meter.snapshot()?.thinkingTokens).toBeUndefined();
		const { record } = recorded(meter.end(end(90)));
		expect(record.thinkingMs).toBeUndefined();
		expect(record.thinkingTokens).toBeUndefined();
		expect(record.thinkingTps).toBeUndefined();
		expect(record.thinkingObserved).toBe(false);
	});
});

describe("live output TPS", () => {
	it("is unavailable 0.8 s after the first output delta", () => {
		start();
		stream("text", 1000, 9, 100, 5);
		expect(meter.snapshot()?.liveTps).toBeUndefined();
	});

	it("uses the time since the first output delta when shorter than 5 s", () => {
		start();
		stream("text", 1000, 30, 100, 5);
		clock.t = 4000;
		expect(meter.snapshot()?.liveTps).toBe(50);
	});

	it("uses the last 5 s at full length", () => {
		start();
		stream("text", 0, 200, 100, 8);
		clock.t = 20_000;
		expect(meter.snapshot()?.liveTps).toBe(80);
	});

	it("applies the calibration ratio", () => {
		start({ ratio: 1.2 });
		stream("text", 0, 20, 100, 5);
		clock.t = 2000;
		const snapshot = meter.snapshot();
		expect(snapshot?.calibrated).toBe(true);
		expect(snapshot?.outputTokens).toBe(120);
		expect(snapshot?.liveTps).toBeCloseTo(60);
	});

	it("marks figures of an uncalibrated model", () => {
		start();
		expect(meter.snapshot()?.calibrated).toBe(false);
	});

	it("does not re-estimate earlier deltas (long stream)", () => {
		start();
		stream("text", 0, 5000, 10, 1);
		expect(estimator.calls).toBe(5000);
		meter.snapshot();
		expect(estimator.calls).toBe(5000);
		// The window includes both ends: 501 deltas of 1 token over 5 s.
		expect(meter.snapshot()?.liveTps).toBeCloseTo(100.2);
	});
});

describe("stall detection", () => {
	it("records a mid-stream pause and excludes it from the active span", () => {
		start();
		stream("text", 0, 11, 100, 10);
		stream("text", 2200, 11, 100, 10);
		const { record } = recorded(meter.end(end(220)));
		expect(record.stallCount).toBe(1);
		expect(record.stallMs).toBe(1200);
		expect(record.outputTps).toBe(110);
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
});

describe("settlement from provider usage", () => {
	it("subtracts reported reasoning tokens", () => {
		start();
		stream("thinking", 0, 10, 100, 40);
		stream("text", 1000, 101, 100, 8);
		const { record } = recorded(meter.end(end(1200, { usage: usage(1200, { reasoning: 400 }) })));
		expect(record.outputTps).toBe(80);
		expect(record.estimated).toBe(false);
	});

	it("subtracts the calibrated thinking estimate without a reasoning breakdown", () => {
		start({ ratio: 0.5 });
		stream("thinking", 0, 10, 50, 70);
		stream("text", 1000, 101, 100, 8);
		const { record } = recorded(meter.end(end(1200)));
		expect(record.thinkingTokens).toBe(350);
		expect(record.outputTps).toBe(85);
		expect(record.estimated).toBe(true);
	});

	it("has no settled TPS for a span under 1 s", () => {
		start();
		stream("text", 0, 5, 100, 5);
		const { record } = recorded(meter.end(end(25)));
		expect(record.burst).toBe(false);
		expect(record.outputTps).toBeUndefined();
	});

	it("falls back to the calibrated estimate when usage.output is missing", () => {
		start({ ratio: 2 });
		stream("text", 0, 11, 100, 10);
		const outcome = recorded(meter.end(end(0)));
		expect(outcome.record.outputTokens).toBe(220);
		expect(outcome.record.outputTps).toBe(220);
		expect(outcome.record.estimated).toBe(true);
		expect(outcome.calibration).toBeUndefined();
	});

	it("produces a calibration sample from reported and estimated tokens", () => {
		start();
		stream("text", 0, 20, 100, 10);
		expect(recorded(meter.end(end(250))).calibration).toEqual({ reported: 250, estimated: 200 });
	});

	it("calibrates on everything streamed without a reasoning breakdown", () => {
		start();
		stream("thinking", 0, 10, 100, 10);
		stream("text", 1000, 20, 100, 10);
		expect(recorded(meter.end(end(330))).calibration).toEqual({ reported: 330, estimated: 300 });
	});

	it("samples (output − reasoning) / raw output estimate with a reasoning breakdown", () => {
		start();
		stream("thinking", 0, 5, 100, 10);
		stream("text", 1000, 25, 100, 10);
		const outcome = recorded(meter.end(end(900, { usage: usage(900, { reasoning: 600 }) })));
		expect(outcome.calibration).toEqual({ reported: 300, estimated: 250 });
	});

	it("calibrates on visible output when thinking was summarised", () => {
		start();
		stream("thinking", 0, 2, 100, 10);
		stream("text", 1000, 20, 100, 10);
		const outcome = recorded(meter.end(end(840, { usage: usage(840, { reasoning: 630 }) })));
		expect(outcome.calibration).toEqual({ reported: 210, estimated: 200 });
	});

	it("calibrates only the streamed part when reasoning was hidden", () => {
		start();
		stream("text", 0, 20, 100, 10);
		const outcome = recorded(meter.end(end(650, { usage: usage(650, { reasoning: 400 }) })));
		expect(outcome.calibration).toEqual({ reported: 250, estimated: 200 });
		expect(outcome.record.thinkingTokens).toBe(400);
		expect(outcome.record.thinkingTps).toBeUndefined();
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
		expect(record.outputTps).toBeUndefined();
		expect(record.throughputTps).toBeUndefined();
	});

	it("report throughput for a response in one chunk", () => {
		start();
		clock.t = 4000;
		meter.delta("text", "x".repeat(900));
		const outcome = recorded(meter.end(end(900)));
		expect(outcome.record.burst).toBe(true);
		expect(outcome.record.burstReason).toBe("few-batches");
		expect(outcome.record.throughputTps).toBe(225);
		expect(outcome.record.outputTps).toBeUndefined();
		expect(outcome.calibration).toBeUndefined();
	});

	it("mark a proxy flush after a long wait", () => {
		start();
		stream("text", 0, 10, 100, 5);
		stream("text", 6900, 10, 0.2, 10);
		expect(recorded(meter.end(end(150))).record.burstReason).toBe("cluster");
	});

	it("mark an implausible settled rate", () => {
		start();
		stream("text", 0, 11, 100, 5);
		const { record } = recorded(meter.end(end(25_000)));
		expect(record.burstReason).toBe("rate");
		expect(record.outputTps).toBeUndefined();
	});
});

describe("aborted, errored and deferred requests", () => {
	it("produce a partial aborted record without calibration", () => {
		start();
		stream("text", 500, 46, 100, 5);
		clock.t = 5500;
		const outcome = recorded(meter.end(end(0, { stopReason: "aborted" })));
		expect(outcome.record.outcome).toBe("aborted");
		expect(outcome.record.burst).toBe(false);
		expect(outcome.record.outputTokens).toBe(230);
		expect(outcome.record.outputTps).toBe(51.11);
		expect(outcome.record.elapsedMs).toBe(5500);
		expect(outcome.calibration).toBeUndefined();
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
