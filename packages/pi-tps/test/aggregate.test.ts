import { describe, expect, it } from "vitest";
import {
	aggregate,
	runsFromEntries,
	summarizeRun,
	summarizeSession,
	thinkingEstimated,
	visibleOutput,
} from "../src/aggregate.ts";
import { parseRunRecord, type RequestRecord, type RunRecord } from "../src/telemetry.ts";

/** A request without thinking: `tokens` output tokens over `ms` of active output. */
function request(tokens = 200, ms = 2000, overrides: Partial<RequestRecord> = {}): RequestRecord {
	return {
		timestamp: 1,
		provider: "p",
		model: "m",
		outcome: "settled",
		burst: false,
		elapsedMs: 3000,
		outputMs: ms,
		generationMs: ms,
		generatedTokens: tokens,
		thinking: "none",
		estimated: false,
		inputTokens: 100,
		outputTokens: tokens,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		deltaCount: 40,
		stallCount: 0,
		stallMs: 0,
		...overrides,
	};
}

/** A request with a thinking phase: every output token counts, over thinking time plus output span. */
function thinkingRequest(
	output: number,
	reasoning: number,
	thinkingMs: number,
	outputMs: number,
	overrides: Partial<RequestRecord> = {},
): RequestRecord {
	return request(output, outputMs, {
		thinking: "streamed",
		thinkingMs,
		thinkingTokens: reasoning,
		reasoningTokens: reasoning,
		generationMs: thinkingMs + outputMs,
		...overrides,
	});
}

/** Output with a reasoning count but no thinking phase: the reasoning tokens are not in the rate. */
function phaseless(output: number, reasoning: number, outputMs: number): RequestRecord {
	return request(output, outputMs, {
		generatedTokens: output - reasoning,
		thinkingTokens: reasoning,
		reasoningTokens: reasoning,
	});
}

function run(requests: RequestRecord[], overrides: Partial<RunRecord> = {}): RunRecord {
	return { version: 2, startedAt: 1, elapsedMs: 10_000, aborted: false, requests, ...overrides };
}

function entry(data: unknown, customType = "pi-tps"): { type: string; customType: string; data: unknown } {
	return { type: "custom", customType, data };
}

describe("aggregate", () => {
	it("weights TPS by generation time over requests with at least 1 s of it (aggregate generation rate)", () => {
		const result = aggregate([request(1000, 10_000), request(300, 2000), request(80, 200)]);
		expect(result.tps).toBeCloseTo(1300 / 12);
		expect(result.visibleOutputTokens).toBe(1380);
	});

	it("counts thinking tokens over thinking time (thinking counts)", () => {
		const result = aggregate([
			thinkingRequest(1200, 400, 5000, 10_000),
			thinkingRequest(360, 300, 3000, 400, { thinking: "hidden" }),
		]);
		expect(result.tps).toBeCloseTo(1560 / 18.4);
		expect(result.tps).toBeCloseTo(84.8, 1);
		expect(result).toMatchObject({ visibleOutputTokens: 860, thinkingTokens: 700, thinkingMs: 8000 });
	});

	describe("reasoning count without a phase", () => {
		it("rates the request, its run and a one-run session by the visible output alone", () => {
			const alone = run([phaseless(1200, 900, 3000)]);
			expect(summarizeRun(alone).tps).toBe(100);
			expect(summarizeSession([alone])?.tps).toBe(100);
		});

		it("weights it by its output span when mixed with a thinking request", () => {
			const mixed = run([phaseless(1200, 900, 3000), thinkingRequest(1200, 400, 5000, 10_000)]);
			const summary = summarizeRun(mixed);
			expect(summary.tps).toBeCloseTo(1500 / 18);
			expect(summary.tps).toBeCloseTo(83.3, 1);
			expect(summarizeSession([mixed])?.tps).toBe(summary.tps);
			expect(summary).toMatchObject({ visibleOutputTokens: 1100, thinkingTokens: 1300, thinkingMs: 5000 });
			expect(summary.estimated).toBe(false);
		});
	});

	it("keeps a generation time just under one second out after persistence (span just under one second)", () => {
		const persisted = parseRunRecord(JSON.parse(JSON.stringify(run([request(110, 999)]))));
		expect(persisted && summarizeRun(persisted).tps).toBeUndefined();
	});

	it("sums hidden and streamed thinking and marks the estimate (hidden and streamed thinking)", () => {
		const result = aggregate([
			thinkingRequest(1200, 900, 20_000, 3000, { thinking: "hidden" }),
			thinkingRequest(600, 100, 2000, 5000, { reasoningTokens: 0 }),
		]);
		expect(result).toMatchObject({ thinkingTokens: 1000, thinkingMs: 22_000, tokensEstimated: true, estimated: false });
	});

	it("excludes burst and aborted requests from TPS and aborted ones from TTFT, but sums all tokens and cost", () => {
		const result = aggregate([
			request(500, 5000, { ttftMs: 1000, cost: 0.01 }),
			request(700, 5000, { ttftMs: 2000 }),
			request(900, 0, { burst: true, ttftMs: 3000, cost: 0.01 }),
			request(64, 900, { outcome: "aborted", ttftMs: 9000 }),
		]);
		expect(result.tps).toBe(120);
		expect(result.ttftMs).toBe(2000);
		expect(result.visibleOutputTokens).toBe(2164);
		expect(result.inputTokens).toBe(400);
		expect(result.cost).toBeCloseTo(0.02);
		expect(result.burstTps).toBeUndefined();
		expect(result.requests).toBe(4);
	});

	it("shows no rate when a burst tool call is followed by a reply too short to measure", () => {
		const result = aggregate([request(59, 0, { burst: true, elapsedMs: 1100 }), request(14, 300)]);
		expect(result.tps).toBeUndefined();
		expect(result.burstTps).toBeUndefined();
	});

	it("falls back to aborted requests when nothing else qualifies (aborted-only run)", () => {
		const result = aggregate([request(230, 2000, { outcome: "aborted", ttftMs: 600, estimated: true })]);
		expect(result.tps).toBe(115);
		expect(result.estimated).toBe(true);
		expect(result.ttftMs).toBe(600);
	});

	it("keeps estimate provenance for burst throughput and summed tokens, separately from the TPS", () => {
		const burstOnly = aggregate([request(900, 0, { burst: true, elapsedMs: 4000, estimated: true })]);
		expect(burstOnly).toMatchObject({ burstTps: 225, estimated: true, tokensEstimated: true });
		const mixed = aggregate([request(400, 2000), request(200, 200, { estimated: true })]);
		expect(mixed).toMatchObject({ tps: 200, estimated: false, tokensEstimated: true });
	});

	it("does not mark the TPS when only the thinking tokens are estimated", () => {
		const result = aggregate([thinkingRequest(1200, 350, 5000, 10_000, { reasoningTokens: 0 })]);
		expect(result).toMatchObject({ tps: 80, estimated: false, tokensEstimated: true });
	});

	it("reports burst throughput when only burst requests exist", () => {
		const result = aggregate([
			request(900, 0, { burst: true, elapsedMs: 4000 }),
			request(300, 0, { burst: true, elapsedMs: 2000 }),
		]);
		expect(result.tps).toBeUndefined();
		expect(result.burstTps).toBe(200);
	});

	it("has no TPS when no request generated for at least 1 s", () => {
		const result = aggregate([request(200, 400), request(200, 900)]);
		expect(result.tps).toBeUndefined();
		expect(result.burstTps).toBeUndefined();
		expect(aggregate([request(200, 400), request(200, 1000)]).tps).toBe(200);
	});

	it("marks the TPS estimated when a contributing request relied on the estimate", () => {
		expect(aggregate([request(), request(200, 2000, { estimated: true })]).estimated).toBe(true);
		expect(aggregate([request(), request(200, 2000, { estimated: true, burst: true })]).estimated).toBe(false);
	});

	it("sums stalls and thinking and takes the colour model from the last contributing request", () => {
		const result = aggregate([
			request(200, 2000, { stallMs: 1200, stallCount: 1, thinkingTokens: 20, thinkingMs: 300, model: "a" }),
			request(200, 2000, { stallMs: 600, stallCount: 2, thinkingTokens: 30, thinkingMs: 200, model: "b" }),
			request(200, 2000, { burst: true, model: "c" }),
		]);
		expect(result).toMatchObject({ stallMs: 1800, stallCount: 3, thinkingTokens: 50, thinkingMs: 500, model: "b" });
	});

	it("leaves cost absent without priced requests", () => {
		expect(aggregate([request()]).cost).toBeUndefined();
	});
});

describe("summaries", () => {
	it("carries the run's elapsed time and aborted flag", () => {
		const summary = summarizeRun(run([request()], { elapsedMs: 18_400, aborted: true }));
		expect(summary).toMatchObject({ elapsedMs: 18_400, aborted: true, requests: 1 });
	});

	it("applies the run formulas to all runs of the session (mixed runs)", () => {
		const session = summarizeSession([
			run([request(600, 10_000)]),
			run([request(400, 5000), thinkingRequest(500, 100, 2000, 3000)]),
		]);
		expect(session?.tps).toBe(75);
		expect(session?.runs).toBe(2);
		expect(session?.requests).toBe(3);
	});

	it("is undefined without runs", () => {
		expect(summarizeSession([])).toBeUndefined();
	});
});

describe("runsFromEntries", () => {
	it("skips foreign custom types, other entries, other versions and malformed runs", () => {
		const runs = runsFromEntries([
			entry(run([request(1)])),
			entry({ version: 1, tps: 80 }, "tps"),
			{ type: "message" },
			entry({ ...run([request()]), version: 3 }),
			entry({ ...run([request()]), requests: [{ broken: true }] }),
			entry(run([request(2)])),
		]);
		expect(runs.map((r) => r.requests[0]?.outputTokens)).toEqual([1, 2]);
	});

	it("ignores version-1 entries, so a resumed branch holding only those starts empty (version-1 record)", () => {
		const { thinking: _thinking, generationMs: _ms, generatedTokens: _tokens, ...v1 } = request();
		const runs = runsFromEntries([entry({ ...run([]), version: 1, requests: [{ ...v1, thinkingObserved: false }] })]);
		expect(runs).toEqual([]);
		expect(summarizeSession(runs)).toBeUndefined();
	});
});

describe("record helpers", () => {
	it("never lets visible output go below 0", () => {
		expect(visibleOutput(request(10, 2000, { thinkingTokens: 20 }))).toBe(0);
	});

	it("knows estimated thinking tokens from the record", () => {
		expect(thinkingEstimated(thinkingRequest(1200, 350, 5000, 1000, { reasoningTokens: 0 }))).toBe(true);
		expect(thinkingEstimated(thinkingRequest(1200, 400, 5000, 1000))).toBe(false);
		expect(thinkingEstimated(thinkingRequest(1200, 900, 5000, 1000, { thinking: "hidden" }))).toBe(false);
		expect(thinkingEstimated(phaseless(1200, 900, 3000))).toBe(false);
	});
});
