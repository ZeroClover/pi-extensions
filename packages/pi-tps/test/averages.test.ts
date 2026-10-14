import { describe, expect, it } from "vitest";
import { ModelAverages, type Smoothed, smooth } from "../src/averages.ts";
import type { ModelRef, RequestRecord } from "../src/telemetry.ts";

/** A settled, streamed request of `p/m` with a rate and a TTFT. */
function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
	return {
		timestamp: 1,
		provider: "p",
		model: "m",
		outcome: "settled",
		burst: false,
		ttftMs: 1000,
		elapsedMs: 11_000,
		outputMs: 10_000,
		generationMs: 10_000,
		generatedTokens: 500,
		tps: 50,
		thinking: "none",
		estimated: false,
		inputTokens: 100,
		outputTokens: 500,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		deltaCount: 100,
		stallCount: 0,
		stallMs: 0,
		...overrides,
	};
}

function fold(samples: number[]): Smoothed | undefined {
	let current: Smoothed | undefined;
	for (const sample of samples) current = smooth(current, sample);
	return current;
}

/** Averages after folding requests of `p/m` with these TPS samples. */
function tpsAverage(samples: number[]): number | undefined {
	const averages = new ModelAverages();
	averages.rebuild(samples.map((tps) => request({ tps })));
	return averages.of("p", "m").tps;
}

const SONNET: ModelRef = { provider: "anthropic", model: "claude-sonnet-4" };
const GPT: ModelRef = { provider: "openai", model: "gpt-5" };

function served(model: ModelRef, overrides: Partial<RequestRecord> = {}): RequestRecord {
	return request({ ...model, ...overrides });
}

describe("smoothing", () => {
	it("takes the mean of the first samples (first samples)", () => {
		expect(tpsAverage([40, 50, 60])).toBe(50);
	});

	it("dilutes a slow first request within ten samples (slow first request)", () => {
		expect(fold([30_000, ...Array.from({ length: 9 }, () => 1000)])?.value).toBeCloseTo(3900);
	});

	it("moves by a tenth of the difference after the warm-up (steady state)", () => {
		const steady = fold(Array.from({ length: 20 }, () => 50));
		expect(steady).toEqual({ value: 50, samples: 20 });
		expect(smooth(steady, 60).value).toBeCloseTo(51);
	});

	it("clamps a sample to three times the average (outlier)", () => {
		const steady = fold(Array.from({ length: 20 }, () => 1000));
		expect(smooth(steady, 30_000).value).toBeCloseTo(1200);
		expect(smooth(steady, 1).value).toBeCloseTo(1000 - 0.1 * (1000 - 1000 / 3));
	});

	it("does not clamp during the warm-up", () => {
		expect(fold([1, 100])?.value).toBe(50.5);
	});
});

describe("samples", () => {
	it("ignores a zero TTFT (zero sample)", () => {
		const averages = new ModelAverages();
		averages.rebuild([request({ ttftMs: 800 }), request({ ttftMs: 0 })]);
		expect(averages.of("p", "m").ttftMs).toBe(800);
	});

	it("rates only requests with a TPS, but takes every TTFT (tool call too short to rate)", () => {
		const averages = new ModelAverages();
		const { tps: _tps, ...toolCall } = request({ generationMs: 400, ttftMs: 2000 });
		averages.rebuild([request({ tps: 50, ttftMs: 1000 }), toolCall]);
		expect(averages.of("p", "m")).toEqual({ tps: 50, ttftMs: 1500 });
	});

	it("leaves the averages unchanged by an aborted request (aborted request)", () => {
		const averages = new ModelAverages();
		averages.rebuild([request()]);
		const before = averages.of("p", "m");
		averages.fold(request({ outcome: "aborted", tps: 5, ttftMs: 9000 }));
		expect(averages.of("p", "m")).toEqual(before);
	});

	it("keeps each model's averages apart (two models)", () => {
		const averages = new ModelAverages();
		averages.rebuild([
			served(SONNET, { tps: 40 }),
			served(GPT, { tps: 90, ttftMs: 3000 }),
			served(SONNET, { tps: 60 }),
		]);
		expect(averages.of(SONNET.provider, SONNET.model)).toEqual({ tps: 50, ttftMs: 1000 });
		expect(averages.of(GPT.provider, GPT.model)).toEqual({ tps: 90, ttftMs: 3000 });
		expect(averages.of("x", "y")).toEqual({});
	});

	it("feeds a burst's throughput and TTFT, not the TPS (burst request ends)", () => {
		const averages = new ModelAverages();
		const { tps: _tps, ...burst } = request({ burst: true, throughputTps: 225, ttftMs: 4000 });
		averages.rebuild([burst]);
		expect(averages.of("p", "m")).toEqual({ burstTps: 225, ttftMs: 4000 });
	});

	it("adds a TPS average next to a burst average (burst and streamed requests)", () => {
		const averages = new ModelAverages();
		const { tps: _tps, ...burst } = request({ burst: true, throughputTps: 225 });
		averages.rebuild([burst]);
		averages.fold(request({ tps: 48 }));
		expect(averages.of("p", "m")).toMatchObject({ tps: 48, burstTps: 225 });
	});

	it("includes a folded request at once (working readout includes the finished request)", () => {
		const averages = new ModelAverages();
		averages.rebuild([request({ tps: 40 })]);
		averages.fold(request({ tps: 60 }));
		expect(averages.of("p", "m").tps).toBe(50);
	});

	it("rebuilds from scratch (branch switch)", () => {
		const averages = new ModelAverages();
		averages.rebuild([request({ tps: 10 }), request({ tps: 20 }), request({ tps: 30 })]);
		averages.rebuild([request({ tps: 70 }), request({ tps: 90 })]);
		expect(averages.of("p", "m").tps).toBe(80);
		averages.rebuild([]);
		expect(averages.of("p", "m")).toEqual({});
		expect(averages.current(SONNET)).toEqual(SONNET);
	});
});

describe("current model", () => {
	it("is the selected model after a switch while idle (model switch while idle)", () => {
		const averages = new ModelAverages();
		averages.rebuild([served(SONNET, { tps: 52.3 }), served(GPT, { tps: 26 })]);
		averages.fold(served(SONNET, { tps: 52.3 }));
		expect(averages.current(SONNET)).toEqual(SONNET);
		expect(averages.current(GPT)).toEqual(GPT);
		expect(averages.of(GPT.provider, GPT.model).tps).toBe(26);
	});

	it("is the serving model behind the selected virtual model (virtual model)", () => {
		const averages = new ModelAverages();
		averages.rebuild([served(SONNET, { requested: { provider: "router", model: "auto" } })]);
		expect(averages.current({ provider: "router", model: "auto" })).toEqual(SONNET);
	});

	it("is the model of the last request after resume (resume)", () => {
		const averages = new ModelAverages();
		averages.rebuild([served(SONNET), served(GPT)]);
		expect(averages.current(GPT)).toEqual(GPT);
	});

	it("follows a selection made before /reload (selection before reload)", () => {
		const averages = new ModelAverages();
		averages.rebuild([served(GPT)]);
		expect(averages.current(SONNET)).toEqual(SONNET);
	});

	it("follows a selection made while tools execute, then aborted (selection while tools execute)", () => {
		const averages = new ModelAverages();
		// The tool-call request was the run's last; the user aborted before another request.
		averages.rebuild([served(GPT, { generationMs: 300 })]);
		expect(averages.current(SONNET)).toEqual(SONNET);
	});

	it("stays the selected model on a branch whose last request went elsewhere (branch navigation)", () => {
		const averages = new ModelAverages();
		averages.rebuild([served(SONNET, { tps: 40 })]);
		averages.rebuild([served(SONNET, { tps: 60 }), served(GPT, { tps: 90 })]);
		expect(averages.current(SONNET)).toEqual(SONNET);
		expect(averages.of(SONNET.provider, SONNET.model).tps).toBe(60);
	});

	it("counts an aborted request as the last one", () => {
		const averages = new ModelAverages();
		averages.rebuild([served(SONNET, { requested: { provider: "router", model: "auto" } })]);
		averages.fold(served(GPT, { outcome: "aborted" }));
		expect(averages.current({ provider: "router", model: "auto" })).toEqual({ provider: "router", model: "auto" });
		expect(averages.current(GPT)).toEqual(GPT);
	});

	it("falls back to the last serving model without a selection, and to nothing without records", () => {
		const averages = new ModelAverages();
		expect(averages.current(undefined)).toBeUndefined();
		averages.fold(served(GPT));
		expect(averages.current(undefined)).toEqual(GPT);
	});
});
