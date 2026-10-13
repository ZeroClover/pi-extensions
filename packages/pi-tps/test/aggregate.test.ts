import { describe, expect, it } from "vitest";
import { aggregate, runsFromEntries, summarizeRun, summarizeSession, visibleOutput } from "../src/aggregate.ts";
import { parseRequestRecord, parseRunRecord, type RequestRecord, type RunRecord } from "../src/telemetry.ts";

function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
	return {
		timestamp: 1,
		provider: "p",
		model: "m",
		outcome: "settled",
		burst: false,
		elapsedMs: 3000,
		outputMs: 2000,
		thinkingObserved: false,
		estimated: false,
		inputTokens: 100,
		outputTokens: 200,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		deltaCount: 40,
		stallCount: 0,
		stallMs: 0,
		...overrides,
	};
}

function run(requests: RequestRecord[], overrides: Partial<RunRecord> = {}): RunRecord {
	return { version: 1, startedAt: 1, elapsedMs: 10_000, aborted: false, requests, ...overrides };
}

function entry(data: unknown, customType = "pi-tps"): { type: string; customType: string; data: unknown } {
	return { type: "custom", customType, data };
}

describe("aggregate", () => {
	it("weights TPS by tokens over requests with at least 1 s of output (token-weighted TPS)", () => {
		const result = aggregate([
			request({ outputTokens: 1000, outputMs: 10_000 }),
			request({ outputTokens: 300, outputMs: 2000 }),
			request({ outputTokens: 80, outputMs: 200 }),
		]);
		expect(result.tps).toBeCloseTo(1300 / 12);
		expect(result.visibleOutputTokens).toBe(1380);
	});

	it("uses visible output, excluding thinking tokens", () => {
		const result = aggregate([request({ outputTokens: 1200, thinkingTokens: 400, outputMs: 10_000 })]);
		expect(result.tps).toBe(80);
		expect(result.visibleOutputTokens).toBe(800);
		expect(result.thinkingTokens).toBe(400);
	});

	it("excludes burst and aborted requests from TPS and aborted ones from TTFT, but sums all tokens and cost", () => {
		const result = aggregate([
			request({ outputTokens: 500, outputMs: 5000, ttftMs: 1000, cost: 0.01 }),
			request({ outputTokens: 700, outputMs: 5000, ttftMs: 2000 }),
			request({ burst: true, outputTokens: 900, outputMs: 0, ttftMs: 3000, cost: 0.01 }),
			request({ outcome: "aborted", outputTokens: 64, outputMs: 900, ttftMs: 9000 }),
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
		const result = aggregate([
			request({ burst: true, outputTokens: 59, elapsedMs: 1100, outputMs: 0 }),
			request({ outputTokens: 14, outputMs: 300 }),
		]);
		expect(result.tps).toBeUndefined();
		expect(result.burstTps).toBeUndefined();
	});

	it("falls back to aborted requests when nothing else qualifies (aborted-only run)", () => {
		const result = aggregate([
			request({ outcome: "aborted", outputTokens: 230, outputMs: 2000, ttftMs: 600, estimated: true }),
		]);
		expect(result.tps).toBe(115);
		expect(result.estimated).toBe(true);
		expect(result.ttftMs).toBe(600);
	});

	it("reports burst throughput when only burst requests exist", () => {
		const result = aggregate([
			request({ burst: true, outputTokens: 900, elapsedMs: 4000 }),
			request({ burst: true, outputTokens: 300, elapsedMs: 2000 }),
		]);
		expect(result.tps).toBeUndefined();
		expect(result.burstTps).toBe(200);
	});

	it("has no TPS when no request streamed for at least 1 s", () => {
		const result = aggregate([request({ outputMs: 400 }), request({ outputMs: 900 })]);
		expect(result.tps).toBeUndefined();
		expect(result.burstTps).toBeUndefined();
		expect(aggregate([request({ outputMs: 400 }), request({ outputMs: 1000 })]).tps).toBe(200);
	});

	it("marks the TPS estimated when a contributing request relied on the estimate", () => {
		expect(aggregate([request(), request({ estimated: true })]).estimated).toBe(true);
		expect(aggregate([request(), request({ estimated: true, burst: true })]).estimated).toBe(false);
	});

	it("sums stalls and thinking and takes the colour model from the last contributing request", () => {
		const result = aggregate([
			request({ stallMs: 1200, stallCount: 1, thinkingTokens: 20, thinkingMs: 300, model: "a" }),
			request({ stallMs: 600, stallCount: 2, thinkingTokens: 30, thinkingMs: 200, model: "b" }),
			request({ burst: true, model: "c" }),
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
			run([request({ outputTokens: 600, outputMs: 10_000 })]),
			run([request({ outputTokens: 400, outputMs: 5000 }), request({ outputTokens: 500, outputMs: 5000 })]),
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
	it("skips foreign custom types, other entries, unknown versions and malformed runs", () => {
		const runs = runsFromEntries([
			entry(run([request({ outputTokens: 1 })])),
			entry({ version: 1, tps: 80 }, "tps"),
			{ type: "message" },
			entry({ ...run([request()]), version: 2 }),
			entry({ ...run([request()]), requests: [{ broken: true }] }),
			entry(run([request({ outputTokens: 2 })])),
		]);
		expect(runs.map((r) => r.requests[0]?.outputTokens)).toEqual([1, 2]);
	});
});

describe("record parsing", () => {
	it("round-trips a run record through JSON", () => {
		const original = run([
			request({ ttftMs: 900, burstReason: "cluster", burst: true, cost: 0.5, responseModel: "x" }),
			request({ outcome: "aborted", clockSkewMs: -300 }),
		]);
		expect(parseRunRecord(JSON.parse(JSON.stringify(original)))).toEqual(original);
	});

	it("rejects runs without requests", () => {
		expect(parseRunRecord(run([]))).toBeUndefined();
	});

	it("rejects malformed request records", () => {
		expect(parseRequestRecord(null)).toBeUndefined();
		expect(parseRequestRecord({ ...request(), outcome: "weird" })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), ttftMs: "1s" })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), inputTokens: undefined })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), outputTokens: -1 })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), ttftMs: -3 })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), clockSkewMs: -300 })?.clockSkewMs).toBe(-300);
	});
});

describe("visibleOutput", () => {
	it("never goes below 0", () => {
		expect(visibleOutput(request({ outputTokens: 10, thinkingTokens: 20 }))).toBe(0);
	});
});
