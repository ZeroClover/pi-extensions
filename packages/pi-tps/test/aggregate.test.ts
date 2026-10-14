import { describe, expect, it } from "vitest";
import { runsFromEntries, sessionTotals, visibleOutput } from "../src/aggregate.ts";
import type { RequestRecord, RunRecord } from "../src/telemetry.ts";

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

function run(requests: RequestRecord[], overrides: Partial<RunRecord> = {}): RunRecord {
	return { version: 2, startedAt: 1, elapsedMs: 10_000, aborted: false, requests, ...overrides };
}

function entry(data: unknown, customType = "pi-tps"): { type: string; customType: string; data: unknown } {
	return { type: "custom", customType, data };
}

describe("sessionTotals", () => {
	it("sums runs, run time and requests over the branch (three runs)", () => {
		const totals = sessionTotals([
			run(
				Array.from({ length: 4 }, () => request()),
				{ elapsedMs: 60_000 },
			),
			run(
				Array.from({ length: 7 }, () => request()),
				{ elapsedMs: 90_000 },
			),
			run(
				Array.from({ length: 3 }, () => request()),
				{ elapsedMs: 102_000 },
			),
		]);
		expect(totals).toMatchObject({ runs: 3, elapsedMs: 252_000, requests: 14, lastAborted: false });
	});

	it("sums input, cache, visible output, thinking and cost over every request", () => {
		const totals = sessionTotals([
			run([
				request(500, 5000, { inputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 300, cost: 0.01 }),
				thinkingRequest(1200, 400, 5000, 10_000, { cost: 0.02 }),
			]),
			run([request(900, 0, { burst: true, inputTokens: 50 })]),
		]);
		expect(totals).toMatchObject({
			runs: 2,
			requests: 3,
			inputTokens: 350,
			cacheReadTokens: 8000,
			cacheWriteTokens: 300,
			visibleOutputTokens: 500 + 800 + 900,
			thinkingTokens: 400,
		});
		expect(totals?.cost).toBeCloseTo(0.03);
	});

	it("includes an aborted last run and marks it (escape during streaming)", () => {
		const totals = sessionTotals([
			run([request(300)]),
			run([request(64, 900, { outcome: "aborted", inputTokens: 40 })], { aborted: true, elapsedMs: 5000 }),
		]);
		expect(totals).toMatchObject({
			runs: 2,
			elapsedMs: 15_000,
			requests: 2,
			inputTokens: 140,
			visibleOutputTokens: 364,
			lastAborted: true,
		});
	});

	it("has no thinking tokens when every phase was hidden without a count (thinking without a count)", () => {
		const {
			thinkingTokens: _t,
			reasoningTokens: _r,
			...hidden
		} = thinkingRequest(500, 0, 4000, 2000, {
			thinking: "hidden",
		});
		expect(sessionTotals([run([hidden])])?.thinkingTokens).toBe(0);
	});

	it("leaves cost absent without priced requests and is undefined without runs", () => {
		expect(sessionTotals([run([request()])])?.cost).toBeUndefined();
		expect(sessionTotals([])).toBeUndefined();
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
		expect(sessionTotals(runs)).toBeUndefined();
	});
});

describe("record helpers", () => {
	it("never lets visible output go below 0", () => {
		expect(visibleOutput(request(10, 2000, { thinkingTokens: 20 }))).toBe(0);
	});
});
