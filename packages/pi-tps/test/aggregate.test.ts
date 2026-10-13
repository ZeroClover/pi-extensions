import { describe, expect, it } from "vitest";
import { aggregate, lastRecord, recordsFromEntries } from "../src/aggregate.ts";
import { parseRecord, type TelemetryRecord } from "../src/telemetry.ts";

function record(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
	return {
		version: 1,
		timestamp: 1,
		provider: "p",
		model: "m",
		outcome: "settled",
		burst: false,
		elapsedMs: 3000,
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

function entry(data: unknown, customType = "pi-tps"): { type: string; customType: string; data: unknown } {
	return { type: "custom", customType, data };
}

describe("aggregate", () => {
	it("is undefined without records", () => {
		expect(aggregate([])).toBeUndefined();
	});

	it("averages TPS over normal requests only (mixed records)", () => {
		const result = aggregate([
			record({ outputTps: 50, ttftMs: 1000, cost: 0.01 }),
			record({ outputTps: 70, ttftMs: 2000 }),
			record({ burst: true, throughputTps: 900, ttftMs: 3000, outputTokens: 900, cost: 0.01 }),
		]);
		expect(result?.count).toBe(3);
		expect(result?.meanOutputTps).toBe(60);
		expect(result?.meanTtftMs).toBe(2000);
		expect(result?.outputTokens).toBe(1300);
		expect(result?.cost).toBeCloseTo(0.02);
	});

	it("excludes aborted requests from averages but sums their tokens", () => {
		const result = aggregate([record({ outputTps: 40 }), record({ outcome: "aborted", outputTps: 10 })]);
		expect(result?.meanOutputTps).toBe(40);
		expect(result?.outputTokens).toBe(400);
	});

	it("averages thinking TPS over requests with thinking and leaves cost absent without any", () => {
		const result = aggregate([record({ thinkingTps: 30 }), record({ thinkingTps: 50 }), record()]);
		expect(result?.meanThinkingTps).toBe(40);
		expect(result?.cost).toBeUndefined();
	});
});

describe("recordsFromEntries", () => {
	it("skips foreign custom types, other entries and unknown versions", () => {
		const records = recordsFromEntries([
			entry(record({ outputTps: 50 })),
			entry({ version: 1, tps: 80 }, "tps"),
			{ type: "message" },
			entry({ ...record(), version: 2 }),
			entry(record({ outputTps: 70 })),
		]);
		expect(records.map((r) => r.outputTps)).toEqual([50, 70]);
	});
});

describe("parseRecord", () => {
	it("round-trips a record through JSON", () => {
		const original = record({ ttftMs: 900, burstReason: "cluster", burst: true, cost: 0.5, responseModel: "x" });
		expect(parseRecord(JSON.parse(JSON.stringify(original)))).toEqual(original);
	});

	it("rejects malformed shapes", () => {
		expect(parseRecord(null)).toBeUndefined();
		expect(parseRecord({ ...record(), outcome: "weird" })).toBeUndefined();
		expect(parseRecord({ ...record(), ttftMs: "1s" })).toBeUndefined();
		expect(parseRecord({ ...record(), inputTokens: undefined })).toBeUndefined();
	});
});

describe("lastRecord", () => {
	it("keeps the previous settled TPS for a request without one", () => {
		const result = lastRecord([record({ outputTps: 42 }), record({ outputTps: 10, burst: true }), record()]);
		expect(result?.fallbackTps).toBe(42);
	});

	it("does not substitute for bursts or aborts", () => {
		expect(lastRecord([record({ outputTps: 42 }), record({ burst: true })])?.fallbackTps).toBeUndefined();
		expect(lastRecord([record({ outputTps: 42 }), record({ outcome: "aborted" })])?.fallbackTps).toBeUndefined();
	});
});
