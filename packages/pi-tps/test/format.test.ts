import { describe, expect, it } from "vitest";
import {
	formatCost,
	formatDuration,
	formatSeconds,
	formatSnapshot,
	formatTokens,
	formatTps,
	plainText,
} from "../src/format.ts";
import type { LiveSnapshot, SessionAggregate, StatusSnapshot, TelemetryRecord } from "../src/telemetry.ts";

function record(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
	return {
		version: 1,
		timestamp: 1,
		provider: "p",
		model: "m",
		outcome: "settled",
		burst: false,
		elapsedMs: 18_400,
		thinkingObserved: false,
		estimated: false,
		inputTokens: 12_345,
		outputTokens: 1500,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		deltaCount: 300,
		stallCount: 0,
		stallMs: 0,
		ttftMs: 1200,
		outputTps: 52,
		...overrides,
	};
}

function text(snapshot: StatusSnapshot, indicator = "⠋"): string {
	return plainText(formatSnapshot(snapshot, indicator));
}

const live: LiveSnapshot = {
	phase: "streaming",
	provider: "p",
	model: "m",
	elapsedMs: 6000,
	ttftMs: 1200,
	liveTps: 48.62,
	outputTokens: 1200,
	calibrated: true,
};

describe("number formatting", () => {
	it("formats token counts with k and M suffixes", () => {
		expect(formatTokens(987)).toBe("987");
		expect(formatTokens(12_345)).toBe("12.3k");
		expect(formatTokens(999.6)).toBe("1.0k");
		expect(formatTokens(999_960)).toBe("1.0M");
		expect(formatTokens(2_345_678)).toBe("2.3M");
	});

	it("formats TPS and TTFT with one decimal", () => {
		expect(formatTps(52)).toBe("52.0");
		expect(formatSeconds(1234)).toBe("1.2s");
	});

	it("formats durations", () => {
		expect(formatDuration(18_400)).toBe("18.4s");
		expect(formatDuration(65_000)).toBe("1m05s");
		expect(formatDuration(3_725_000)).toBe("1h02m");
	});

	it("formats cost by magnitude", () => {
		expect(formatCost(0.0123)).toBe("$0.012");
		expect(formatCost(0.0042)).toBe("$0.0042");
		expect(formatCost(1.5)).toBe("$1.50");
	});
});

describe("phases", () => {
	it("waiting shows the spinner, a counting TTFT and a TPS placeholder", () => {
		expect(text({ ...live, phase: "waiting", elapsedMs: 700 })).toBe("⠋ τ0.7s Δ–");
	});

	it("streaming shows locked TTFT, live TPS, estimated output and thinking", () => {
		expect(text({ ...live, thinkingTokens: 1900, thinkingMs: 4000 }, "⠙")).toBe("⠙ τ1.2s Δ48.6 ↓1.2k ∴↓1.9k 4.0s");
	});

	it("streaming shows a placeholder before live TPS is available", () => {
		const { liveTps: _omit, ...early } = live;
		expect(text(early)).toBe("⠋ τ1.2s Δ– ↓1.2k");
	});

	it("settled shows TTFT, TPS, tokens, elapsed, cost and thinking", () => {
		const settled = record({ cost: 0.012, thinkingTps: 60.1, thinkingMs: 4000 });
		expect(text({ phase: "last", record: settled })).toBe("✓ τ1.2s Δ52.0 ↑12.3k ↓1.5k 18.4s $0.012 ∴Δ60.1 4.0s");
	});

	it("idle without data shows placeholders for the selected mode", () => {
		expect(text({ phase: "empty", mode: "last" })).toBe("· τ– Δ–");
		expect(text({ phase: "empty", mode: "session" })).toBe("Σ τ– Δ–");
	});

	it("session mode shows averages, sums, cost and the request count", () => {
		const aggregate: SessionAggregate = {
			count: 3,
			meanTtftMs: 1000,
			meanOutputTps: 55.3,
			inputTokens: 40_000,
			outputTokens: 6200,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0.05,
		};
		expect(text({ phase: "session", aggregate })).toBe("Σ τ1.0s Δ55.3 ↑40.0k ↓6.2k $0.050 ×3");
	});
});

describe("displayed fields", () => {
	it("uses k suffixes for large counts and plain numbers below 1000", () => {
		expect(text({ phase: "last", record: record({ inputTokens: 12_345, outputTokens: 987 }) })).toContain(
			"↑12.3k ↓987",
		);
	});

	it("folds cache reads into the input figure with a cache marker", () => {
		const cached = record({ inputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 0 });
		expect(text({ phase: "last", record: cached })).toContain("↑8.2k↻");
	});

	it("omits cost when the record has none", () => {
		expect(text({ phase: "last", record: record() })).not.toContain("$");
	});

	it("marks the TPS segment for threshold colouring", () => {
		const segments = formatSnapshot({ phase: "last", record: record() }, "");
		expect(segments.filter((segment) => segment.tps !== undefined)).toEqual([{ text: "Δ52.0", tps: 52 }]);
	});

	it("shows the previous settled TPS for a request without one", () => {
		const { outputTps: _omit, ...short } = record();
		expect(text({ phase: "last", record: short, fallbackTps: 41 })).toContain("Δ41.0");
	});
});

describe("markers", () => {
	it("marks a burst request and shows its throughput uncoloured", () => {
		const { outputTps: _omit, ...base } = record({ burst: true, throughputTps: 225, ttftMs: 4000, elapsedMs: 4000 });
		const segments = formatSnapshot({ phase: "last", record: base }, "");
		expect(plainText(segments)).toBe("✓ τ4.0s ↯225.0 ↑12.3k ↓1.5k 4.0s");
		expect(segments.some((segment) => segment.tps !== undefined)).toBe(false);
	});

	it("marks an aborted request", () => {
		expect(text({ phase: "last", record: record({ outcome: "aborted", outputTps: 47 }) })).toMatch(/^✗ τ1\.2s Δ47\.0 /);
	});

	it("marks uncalibrated live figures", () => {
		expect(text({ ...live, calibrated: false })).toBe("⠋ τ1.2s Δ48.6~ ↓1.2k~");
	});

	it("marks settled figures that rely on the estimate", () => {
		expect(text({ phase: "last", record: record({ estimated: true }) })).toContain("Δ52.0~");
	});

	it("marks the session mode", () => {
		const aggregate: SessionAggregate = {
			count: 1,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		expect(text({ phase: "session", aggregate })).toMatch(/^Σ /);
	});
});
