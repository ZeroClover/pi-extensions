import { describe, expect, it } from "vitest";
import { parseRequestRecord, parseRunRecord, type RequestRecord, type RunRecord } from "../src/telemetry.ts";

function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
	return {
		timestamp: 1,
		provider: "p",
		model: "m",
		outcome: "settled",
		burst: false,
		elapsedMs: 16_000,
		outputMs: 10_000,
		generationMs: 15_000,
		generatedTokens: 1200,
		tps: 80,
		outputTps: 80,
		thinkingTps: 80,
		thinkingMs: 5000,
		thinkingTokens: 400,
		reasoningTokens: 400,
		thinking: "streamed",
		estimated: false,
		inputTokens: 100,
		outputTokens: 1200,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		deltaCount: 140,
		stallCount: 0,
		stallMs: 0,
		...overrides,
	};
}

function run(requests: RequestRecord[]): RunRecord {
	return { version: 2, startedAt: 1, elapsedMs: 20_000, aborted: false, requests };
}

describe("run records", () => {
	it("round-trip a version-2 record through JSON", () => {
		const original = run([
			request(),
			request({ thinking: "hidden", thinkingTokens: 900, outputTps: 100 }),
			request({ thinking: "none", generatedTokens: 300, generationMs: 3000, burst: true, burstReason: "rate" }),
		]);
		expect(parseRunRecord(JSON.parse(JSON.stringify(original)))).toEqual(original);
	});

	it("reject version 1 and future versions", () => {
		expect(parseRunRecord({ ...run([request()]), version: 1 })).toBeUndefined();
		expect(parseRunRecord({ ...run([request()]), version: 3 })).toBeUndefined();
	});

	it("reject a version-1 request shape", () => {
		const { thinking: _thinking, generationMs: _ms, generatedTokens: _tokens, ...v1 } = request();
		expect(parseRequestRecord({ ...v1, thinkingObserved: true })).toBeUndefined();
	});

	it("reject malformed thinking values", () => {
		expect(parseRequestRecord({ ...request(), thinking: "visible" })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), thinking: true })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), thinking: undefined })).toBeUndefined();
	});

	it("reject negative or missing generation figures", () => {
		expect(parseRequestRecord({ ...request(), generationMs: -1 })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), generatedTokens: undefined })).toBeUndefined();
		expect(parseRequestRecord({ ...request(), tps: "80" })).toBeUndefined();
	});

	it("round-trip the selected model of a virtual model (virtual model)", () => {
		const routed = request({
			provider: "anthropic",
			model: "claude-sonnet-4",
			requested: { provider: "router", model: "auto" },
		});
		expect(parseRequestRecord(JSON.parse(JSON.stringify(routed)))).toEqual(routed);
	});

	it("accept a record without requested and drop a malformed one (record written before this change)", () => {
		const legacy = parseRequestRecord(request());
		expect(legacy).toBeDefined();
		expect(legacy?.requested).toBeUndefined();
		expect(parseRequestRecord({ ...request(), requested: { provider: "router" } })?.requested).toBeUndefined();
		expect(parseRequestRecord({ ...request(), requested: "router/auto" })).toEqual(request());
	});
});
