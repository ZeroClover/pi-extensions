import { describe, expect, it } from "vitest";
import type { LabelStyle } from "../src/config.ts";
import { formatCost, formatDuration, formatSnapshot, formatTokens, formatTps, plainText } from "../src/format.ts";
import type { LiveSnapshot, RunSummary, SessionSummary, StatusSnapshot } from "../src/telemetry.ts";

function both(snapshot: StatusSnapshot, indicator = "⠋"): Record<LabelStyle, string> {
	return {
		text: plainText(formatSnapshot(snapshot, "text", indicator), "text"),
		symbols: plainText(formatSnapshot(snapshot, "symbols", indicator), "symbols"),
	};
}

const live: LiveSnapshot = {
	phase: "streaming",
	provider: "p",
	model: "m",
	request: 1,
	elapsedMs: 6000,
	ttftMs: 1200,
	liveTps: 48.62,
	outputTokens: 1200,
	thinking: "none",
	calibrated: true,
	thinkingCalibrated: true,
	tpsCalibrated: true,
};

function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
	return {
		requests: 3,
		tps: 110.5,
		estimated: false,
		tokensEstimated: false,
		ttftMs: 700,
		inputTokens: 500,
		cacheReadTokens: 5700,
		cacheWriteTokens: 0,
		visibleOutputTokens: 1400,
		thinkingTokens: 94,
		thinkingMs: 4100,
		stallMs: 1200,
		stallCount: 1,
		cost: 0.0018,
		elapsedMs: 18_400,
		aborted: false,
		...overrides,
	};
}

function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		requests: 9,
		tps: 110,
		estimated: false,
		tokensEstimated: false,
		ttftMs: 600,
		inputTokens: 40_000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		visibleOutputTokens: 6200,
		thinkingTokens: 0,
		thinkingMs: 0,
		stallMs: 0,
		stallCount: 0,
		cost: 0.05,
		runs: 3,
		...overrides,
	};
}

describe("number formatting", () => {
	it("formats token counts with K, M and B, dropping .0", () => {
		expect(formatTokens(987)).toBe("987");
		expect(formatTokens(12_345)).toBe("12.3K");
		expect(formatTokens(40_000)).toBe("40K");
		expect(formatTokens(999.6)).toBe("1K");
		expect(formatTokens(999_960)).toBe("1M");
		expect(formatTokens(2_345_678)).toBe("2.3M");
		expect(formatTokens(1_500_000_000)).toBe("1.5B");
	});

	it("formats durations with one decimal below a minute, then two units", () => {
		expect(formatDuration(1234)).toBe("1.2s");
		expect(formatDuration(45_000)).toBe("45.0s");
		expect(formatDuration(90_000)).toBe("1m 30s");
		expect(formatDuration(8_100_000)).toBe("2h 15m");
		expect(formatDuration(302_400_000)).toBe("3d 12h");
	});

	it("formats TPS and cost", () => {
		expect(formatTps(52)).toBe("52.0");
		expect(formatCost(0.0123)).toBe("$0.012");
		expect(formatCost(0.0042)).toBe("$0.0042");
		expect(formatCost(1.5)).toBe("$1.50");
	});
});

describe("readout phases", () => {
	it("waiting shows the spinner and a counting TTFT", () => {
		expect(both({ ...live, phase: "waiting", elapsedMs: 1200 })).toEqual({ text: "⠋ TTFT 1.2s", symbols: "⠋ ⇥1.2s" });
	});

	it("streaming shows live TPS, TTFT, output, thinking and the request number", () => {
		const snapshot: LiveSnapshot = {
			...live,
			outputTokens: 1200,
			thinking: "streamed",
			thinkingTokens: 1900,
			thinkingMs: 4000,
			request: 2,
		};
		expect(both(snapshot, "⠙")).toEqual({
			text: "⠙ TPS 48.6 tok/s · TTFT 1.2s · out 1.2K · think 1.9K 4.0s · req 2",
			symbols: "⠙ »48.6/s ⇥1.2s ↓1.2K ✻1.9K 4.0s ×2",
		});
	});

	it("streaming shows — before live TPS is available", () => {
		const { liveTps: _omit, ...early } = live;
		expect(both(early)).toEqual({ text: "⠋ TPS — · TTFT 1.2s · out 1.2K", symbols: "⠋ »— ⇥1.2s ↓1.2K" });
	});

	it("shows the duration of a phase without deltas and counts TTFT up (hidden thinking in progress)", () => {
		const { liveTps: _tps, ttftMs: _ttft, ...rest } = live;
		const hidden: LiveSnapshot = { ...rest, elapsedMs: 4200, outputTokens: 0, thinking: "hidden", thinkingMs: 4000 };
		expect(both(hidden)).toEqual({ text: "⠋ TPS — · TTFT 4.2s · think 4.0s", symbols: "⠋ »— ⇥4.2s ✻4.0s" });
	});

	it("shows the generation rate while a summary streams (streaming a thinking summary)", () => {
		const summary: LiveSnapshot = {
			...live,
			liveTps: 160,
			outputTokens: 0,
			thinking: "streamed",
			thinkingTokens: 1900,
			thinkingMs: 4000,
		};
		expect(both(summary)).toEqual({
			text: "⠋ TPS 160.0 tok/s · TTFT 1.2s · out 0 · think 1.9K 4.0s",
			symbols: "⠋ »160.0/s ⇥1.2s ↓0 ✻1.9K 4.0s",
		});
	});

	it("working shows run time, requests and output, and no rate", () => {
		expect(
			both({ phase: "working", elapsedMs: 12_300, requests: 1, outputTokens: 1600, estimated: false }, "⠹"),
		).toEqual({
			text: "⠹ run 12.3s · req 1 · out 1.6K",
			symbols: "⠹ 12.3s ×1 ↓1.6K",
		});
	});

	it("shows no data as — in either mode", () => {
		expect(both({ phase: "empty", mode: "last" })).toEqual({ text: "TPS — · TTFT —", symbols: "· »— ⇥—" });
		expect(both({ phase: "empty", mode: "session" })).toEqual({
			text: "session · TPS — · TTFT —",
			symbols: "Σ »— ⇥—",
		});
	});
});

describe("run summary", () => {
	it("shows every available field in both styles (default style, symbol style)", () => {
		expect(both({ phase: "run", run: runSummary() })).toEqual({
			text: "TPS 110.5 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%) · out 1.4K · think 94 4.1s · stall 1.2s×1 · req 3 · $0.0018",
			symbols: "✓ »110.5/s ⇥0.7s 18.4s ↑6.2K ↻92% ↓1.4K ✻94 4.1s ‖1.2s×1 ×3 $0.0018",
		});
	});

	it("shows the generation rate with visible output and thinking (thinking model)", () => {
		const summary = runSummary({
			tps: 80,
			requests: 1,
			visibleOutputTokens: 800,
			thinkingTokens: 400,
			thinkingMs: 5000,
			stallMs: 0,
		});
		expect(both({ phase: "run", run: summary }).text).toBe(
			"TPS 80.0 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%) · out 800 · think 400 5.0s · req 1 · $0.0018",
		);
	});

	it("shows a reasoning count without a duration (reasoning count without a phase)", () => {
		const summary = runSummary({ tps: 100, thinkingTokens: 900, thinkingMs: 0, stallMs: 0 });
		expect(both({ phase: "run", run: summary })).toMatchObject({
			text: expect.stringContaining("out 1.4K · think 900 · req 3"),
			symbols: expect.stringContaining("↓1.4K ✻900 ×3"),
		});
	});

	it("shows the duration alone for hidden thinking without a count", () => {
		const summary = runSummary({ thinkingTokens: 0, thinkingMs: 7500, stallMs: 0 });
		expect(both({ phase: "run", run: summary }).text).toContain("out 1.4K · think 7.5s · req 3");
	});

	it("replaces TPS with the burst throughput in a burst-only run", () => {
		const { tps: _omit, ...rest } = runSummary({
			burstTps: 225,
			requests: 1,
			ttftMs: 4000,
			elapsedMs: 4000,
			inputTokens: 3100,
			cacheReadTokens: 0,
			visibleOutputTokens: 900,
			thinkingTokens: 0,
			thinkingMs: 0,
			stallMs: 0,
		});
		const { cost: _cost, ...summary } = rest;
		expect(both({ phase: "run", run: summary })).toEqual({
			text: "burst 225.0 tok/s · TTFT 4.0s · 4.0s · in 3.1K · out 900 · req 1",
			symbols: "✓ ↯225.0/s ⇥4.0s 4.0s ↑3.1K ↓900 ×1",
		});
	});

	it("marks an aborted run and omits empty input", () => {
		const { cost: _cost, ...summary } = runSummary({
			aborted: true,
			tps: 47,
			requests: 1,
			ttftMs: 600,
			elapsedMs: 5000,
			inputTokens: 0,
			cacheReadTokens: 0,
			visibleOutputTokens: 64,
			thinkingTokens: 0,
			thinkingMs: 0,
			stallMs: 0,
		});
		expect(both({ phase: "run", run: summary })).toEqual({
			text: "aborted · TPS 47.0 tok/s · TTFT 0.6s · 5.0s · out 64 · req 1",
			symbols: "✗ »47.0/s ⇥0.6s 5.0s ↓64 ×1",
		});
	});

	it("marks a run TPS that relies on the estimate", () => {
		expect(both({ phase: "run", run: runSummary({ estimated: true }) }).text).toMatch(/^TPS ~110\.5 tok\/s/);
	});

	it("shows — when neither TPS nor throughput is known", () => {
		const { tps: _omit, ...summary } = runSummary();
		expect(both({ phase: "run", run: summary }).text).toMatch(/^TPS — · /);
	});
});

describe("session summary", () => {
	it("shows the session marker, TPS, TTFT, tokens, runs and cost", () => {
		expect(both({ phase: "session", session: sessionSummary() })).toEqual({
			text: "session · TPS 110.0 tok/s · TTFT 0.6s · in 40K · out 6.2K · runs 3 · $0.050",
			symbols: "Σ »110.0/s ⇥0.6s ↑40K ↓6.2K ×3 $0.050",
		});
	});
});

describe("displayed fields", () => {
	it("uses K for large counts and plain numbers below 1000", () => {
		const summary = runSummary({ inputTokens: 12_345, cacheReadTokens: 0, visibleOutputTokens: 987 });
		expect(both({ phase: "run", run: summary }).text).toContain("in 12.3K · out 987");
	});

	it("folds cache reads into the input with their share (cached input)", () => {
		const summary = runSummary({ inputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 0 });
		expect(both({ phase: "run", run: summary })).toMatchObject({
			text: expect.stringContaining("in 8.2K (cache 98%)"),
			symbols: expect.stringContaining("↑8.2K ↻98%"),
		});
	});

	it("marks every uncalibrated live estimate (uncalibrated live figure)", () => {
		expect(both({ ...live, calibrated: false, tpsCalibrated: false })).toEqual({
			text: "⠋ TPS ~48.6 tok/s · TTFT 1.2s · out ~1.2K",
			symbols: "⠋ »~48.6/s ⇥1.2s ↓~1.2K",
		});
	});

	it("keeps the marker on token counts before live TPS is available (uncalibrated warm-up)", () => {
		const { liveTps: _omit, ...early } = live;
		const warmUp: LiveSnapshot = {
			...early,
			ttftMs: 700,
			outputTokens: 10,
			thinking: "streamed",
			thinkingTokens: 30,
			calibrated: false,
			thinkingCalibrated: false,
			tpsCalibrated: false,
		};
		expect(both(warmUp)).toEqual({
			text: "⠋ TPS — · TTFT 0.7s · out ~10 · think ~30",
			symbols: "⠋ »— ⇥0.7s ↓~10 ✻~30",
		});
	});

	it("marks only the figures resting on an uncalibrated kind (output calibrated, thinking not)", () => {
		const snapshot: LiveSnapshot = {
			...live,
			outputTokens: 40,
			thinking: "streamed",
			thinkingTokens: 300,
			thinkingMs: 4000,
			thinkingCalibrated: false,
			tpsCalibrated: false,
		};
		expect(both(snapshot)).toEqual({
			text: "⠋ TPS ~48.6 tok/s · TTFT 1.2s · out 40 · think ~300 4.0s",
			symbols: "⠋ »~48.6/s ⇥1.2s ↓40 ✻~300 4.0s",
		});
		expect(both({ ...snapshot, tpsCalibrated: true }).text).toBe(
			"⠋ TPS 48.6 tok/s · TTFT 1.2s · out 40 · think ~300 4.0s",
		);
	});

	it("marks summed tokens that rely on the estimate, independently of the TPS", () => {
		const summary = runSummary({ tokensEstimated: true });
		expect(both({ phase: "run", run: summary }).text).toContain(
			"TPS 110.5 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%) · out ~1.4K · think ~94 4.1s",
		);
	});

	it("marks the working phase's output when a finished request relied on the estimate", () => {
		expect(both({ phase: "working", elapsedMs: 1000, requests: 1, outputTokens: 59, estimated: true }).text).toBe(
			"⠋ run 1.0s · req 1 · out ~59",
		);
	});

	it("tags only the TPS segment for threshold colouring, and not the burst throughput", () => {
		const line = formatSnapshot({ phase: "run", run: runSummary() }, "text", "");
		expect(line.segments.filter((segment) => segment.tps !== undefined)).toEqual([
			{ text: "TPS 110.5 tok/s", tps: 110.5 },
		]);
		const { tps: _omit, ...burstOnly } = runSummary({ burstTps: 225 });
		const burstLine = formatSnapshot({ phase: "run", run: burstOnly }, "text", "");
		expect(burstLine.segments.some((segment) => segment.tps !== undefined)).toBe(false);
	});
});
