import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.ts";
import { formatCost, formatDuration, formatSnapshot, formatTokens, formatTps, MEAN, plainText } from "../src/format.ts";
import type {
	Averages,
	IdleSnapshot,
	LiveSnapshot,
	SessionTotals,
	StatusSnapshot,
	WorkingSnapshot,
} from "../src/telemetry.ts";

const METRICS = { tps: defaultConfig().tps, ttft: defaultConfig().ttft };

function text(snapshot: StatusSnapshot, indicator = "⠋"): string {
	return plainText(formatSnapshot(snapshot, indicator, METRICS));
}

/** The serving model of the proposal's examples. */
const AVERAGE: Averages = { tps: 52.3, ttftMs: 1100 };

const streaming: LiveSnapshot = {
	phase: "streaming",
	provider: "p",
	model: "m",
	request: 1,
	elapsedMs: 6000,
	ttftMs: 1200,
	liveTps: 48.62,
	outputTokens: 1200,
	thinking: "none",
	average: AVERAGE,
};

function waiting(elapsedMs: number, average: Averages, request = 1): LiveSnapshot {
	const { ttftMs: _ttft, liveTps: _tps, ...rest } = streaming;
	return { ...rest, phase: "waiting", elapsedMs, request, outputTokens: 0, average };
}

function hidden(average: Averages): LiveSnapshot {
	const { ttftMs: _ttft, liveTps: _tps, ...rest } = streaming;
	return { ...rest, elapsedMs: 4200, outputTokens: 0, thinking: "hidden", thinkingMs: 4000, average };
}

function workingSnapshot(average: Averages): WorkingSnapshot {
	return { phase: "working", elapsedMs: 12_300, requests: 1, outputTokens: 1600, average };
}

function totals(overrides: Partial<SessionTotals> = {}): SessionTotals {
	return {
		runs: 3,
		elapsedMs: 252_000,
		requests: 14,
		inputTokens: 4800,
		cacheReadTokens: 35_200,
		cacheWriteTokens: 0,
		visibleOutputTokens: 6200,
		thinkingTokens: 2100,
		cost: 0.05,
		lastAborted: false,
		...overrides,
	};
}

function idle(average: Averages, session?: SessionTotals): IdleSnapshot {
	return session ? { phase: "idle", average, session } : { phase: "idle", average };
}

const burstOnly = (() => {
	const { cost: _cost, ...rest } = totals({
		runs: 2,
		elapsedMs: 9100,
		requests: 2,
		inputTokens: 6200,
		cacheReadTokens: 0,
		visibleOutputTokens: 1800,
		thinkingTokens: 0,
	});
	return rest;
})();

/** The proposal's example lines, which the README repeats, with the snapshots that produce them. */
const EXAMPLES: [name: string, snapshot: StatusSnapshot, indicator: string, line: string][] = [
	["first request of a model: no average (first request of a model)", waiting(1400, {}), "⠋", "⠋ - TPS | TTFT 1.4s"],
	[
		"waiting for the first token of the run's second request",
		waiting(2000, AVERAGE, 2),
		"⠹",
		"⠹ - (x̄52.3) TPS | TTFT 2.0s (x̄1.1s) | 2➤",
	],
	[
		"streaming",
		{
			...streaming,
			liveTps: 68.3,
			ttftMs: 600,
			thinking: "streamed",
			thinkingTokens: 1900,
			thinkingMs: 4000,
			request: 2,
		},
		"⠼",
		"⠼ 68.3 (x̄52.3) TPS | TTFT 0.6s (x̄1.1s) | ↓1.2K | ⠿1.9K 4.0s | 2➤",
	],
	["hidden thinking", hidden(AVERAGE), "⠧", "⠧ - (x̄52.3) TPS | TTFT 4.2s (x̄1.1s) | ⠿4.0s"],
	[
		"working: averages, then this run's progress",
		workingSnapshot({ tps: 52.4, ttftMs: 1000 }),
		"⠇",
		"⠇ x̄52.4 TPS | TTFT x̄1.0s | run 12.3s | 1➤ | ↓1.6K",
	],
	[
		"idle after three runs (three runs)",
		idle({ tps: 52.4, ttftMs: 1000 }, totals()),
		"",
		"✓ x̄52.4 TPS | TTFT x̄1.0s | 3 runs in 4m 12s | 14➤ | ↑40K ◎88% | ↓6.2K | ⠿2.1K | $0.050",
	],
	[
		"idle after an aborted fourth run (last run aborted)",
		idle(
			{ tps: 52.1, ttftMs: 1000 },
			totals({
				runs: 4,
				elapsedMs: 257_000,
				requests: 15,
				inputTokens: 5060,
				cacheReadTokens: 40_940,
				visibleOutputTokens: 6300,
				cost: 0.054,
				lastAborted: true,
			}),
		),
		"",
		"✗ x̄52.1 TPS | TTFT x̄1.0s | 4 runs in 4m 17s | 15➤ | ↑46K ◎89% | ↓6.3K | ⠿2.1K | $0.054",
	],
	[
		"idle with a burst-only model and a price",
		idle({ burstTps: 225, ttftMs: 4000 }, { ...burstOnly, cost: 0.004 }),
		"",
		"✓ x̄↯225.0 TPS | TTFT x̄4.0s | 2 runs in 9.1s | 2➤ | ↑6.2K | ↓1.8K | $0.0040",
	],
	["nothing measured on this branch (no data)", idle({}), "", "- TPS | TTFT -"],
];

describe("the proposal's example lines", () => {
	it.each(EXAMPLES)("%s", (_name, snapshot, indicator, line) => {
		expect(text(snapshot, indicator)).toBe(line);
	});

	it("are the README's example lines", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const block = /<!-- example-lines[^>]*-->\s*```text\n([\s\S]*?)```/.exec(readme)?.[1];
		expect(block?.trimEnd().split("\n")).toEqual(EXAMPLES.map(([, , , line]) => line));
	});
});

describe("readout phases", () => {
	it("waiting shows the live TPS as - and a counting TTFT (waiting)", () => {
		expect(text(waiting(1200, AVERAGE))).toBe("⠋ - (x̄52.3) TPS | TTFT 1.2s (x̄1.1s)");
	});

	it("streaming shows live figures next to the averages (streaming)", () => {
		const snapshot: LiveSnapshot = {
			...streaming,
			thinking: "streamed",
			thinkingTokens: 1900,
			thinkingMs: 4000,
			request: 2,
		};
		expect(text(snapshot, "⠙")).toBe("⠙ 48.6 (x̄52.3) TPS | TTFT 1.2s (x̄1.1s) | ↓1.2K | ⠿1.9K 4.0s | 2➤");
	});

	it("streams a thinking summary with a rate, ↓0 and the thinking count (streaming a thinking summary)", () => {
		const summary: LiveSnapshot = {
			...streaming,
			liveTps: 160,
			outputTokens: 0,
			thinking: "streamed",
			thinkingTokens: 1900,
			thinkingMs: 4000,
		};
		expect(text(summary)).toBe("⠋ 160.0 (x̄52.3) TPS | TTFT 1.2s (x̄1.1s) | ↓0 | ⠿1.9K 4.0s");
	});

	it("working shows no live rate (working between requests)", () => {
		expect(text(workingSnapshot({ tps: 52.4, ttftMs: 1000 }), "⠹")).toBe(
			"⠹ x̄52.4 TPS | TTFT x̄1.0s | run 12.3s | 1➤ | ↓1.6K",
		);
	});

	it("working without an average shows - (no average yet)", () => {
		expect(text(workingSnapshot({}), "⠹")).toBe("⠹ - TPS | TTFT - | run 12.3s | 1➤ | ↓1.6K");
	});

	it("shows the burst average in parentheses while waiting (burst average)", () => {
		expect(text(waiting(1000, { burstTps: 225 }))).toBe("⠋ - (x̄↯225.0) TPS | TTFT 1.0s");
	});

	it("shows the TPS average instead of a burst average (burst and streamed requests)", () => {
		expect(text(waiting(1000, { tps: 48, burstTps: 225 }))).toBe("⠋ - (x̄48.0) TPS | TTFT 1.0s");
		expect(text(idle({ tps: 48, burstTps: 225 }, totals()))).toMatch(/^✓ x̄48\.0 TPS \| /);
	});

	it("idle with a model that has no average keeps the totals (current model without an average)", () => {
		expect(text(idle({}, totals()))).toBe(
			"✓ - TPS | TTFT - | 3 runs in 4m 12s | 14➤ | ↑40K ◎88% | ↓6.2K | ⠿2.1K | $0.050",
		);
	});

	it("idle with a burst-only model without cache, thinking or price (burst-only model)", () => {
		expect(text(idle({ burstTps: 225, ttftMs: 4000 }, burstOnly))).toBe(
			"✓ x̄↯225.0 TPS | TTFT x̄4.0s | 2 runs in 9.1s | 2➤ | ↑6.2K | ↓1.8K",
		);
	});

	it("idle without runs ignores averages (no data)", () => {
		expect(text(idle({ tps: 50 }))).toBe("- TPS | TTFT -");
	});
});

describe("fixed field vocabulary (notation of every field)", () => {
	it("writes the average sign as x with a combining macron", () => {
		expect(MEAN).toBe("x̄");
		expect(MEAN).toBe("x̄");
	});

	it("uses the notation of the table", () => {
		const live = text(streaming);
		expect(live).toContain("48.6 (x̄52.3) TPS");
		expect(live).toContain("TTFT 1.2s (x̄1.1s)");
		expect(live).toContain("↓1.2K");
		const { liveTps: _omit, ...early } = streaming;
		expect(text(early)).toContain("- (x̄52.3) TPS");
		expect(text(waiting(0, { burstTps: 225 }))).toContain("(x̄↯225.0)");
		const averages = text(workingSnapshot({ tps: 52.3, ttftMs: 1100 }));
		expect(averages).toContain("x̄52.3 TPS");
		expect(averages).toContain("TTFT x̄1.1s");
		expect(averages).toContain("run 12.3s");
		expect(averages).toContain("1➤");
		expect(text(idle({ burstTps: 225 }, totals()))).toContain("x̄↯225.0 TPS");
		expect(text(idle({}, totals({ inputTokens: 500, cacheReadTokens: 5700 })))).toContain("↑6.2K ◎92%");
		expect(text(idle({}, totals({ cacheReadTokens: 0, inputTokens: 6200 })))).toContain("| ↑6.2K | ");
		expect(text(hidden({}))).toContain("⠿4.0s");
		expect(text(idle({}, totals()))).toContain("| ⠿2.1K |");
		expect(text(idle({}, totals({ runs: 1, elapsedMs: 18_400 })))).toContain("1 run in 18.4s");
		expect(text(idle({}, totals()))).toContain("3 runs in 4m 12s");
		expect(text(idle({}, totals()))).toMatch(/\$0\.050$/);
	});

	it("starts with the outcome marker or the spinner frame", () => {
		expect(formatSnapshot(idle({}, totals()), "⠋", METRICS).marker).toEqual({ text: "✓", role: "success" });
		expect(formatSnapshot(idle({}, totals({ lastAborted: true })), "⠋", METRICS).marker).toEqual({
			text: "✗",
			role: "error",
		});
		expect(formatSnapshot(streaming, "⠧", METRICS).marker).toEqual({ text: "⠧", role: "base" });
		expect(formatSnapshot(idle({}), "⠋", METRICS).marker).toBeUndefined();
	});

	it("marks no live figure as an estimate (uncalibrated estimate)", () => {
		const line = text(streaming);
		expect(line).toBe("⠋ 48.6 (x̄52.3) TPS | TTFT 1.2s (x̄1.1s) | ↓1.2K");
		expect(line).not.toContain("~");
	});

	it("shows no stall field (output paused)", () => {
		expect(text(idle({}, totals()))).not.toMatch(/stall|‖/);
	});

	it("omits a duration under 50 ms and a thinking field without a count", () => {
		expect(text({ ...streaming, thinking: "streamed", thinkingTokens: 30, thinkingMs: 20 })).toMatch(/\| ⠿30$/);
		expect(text(idle({}, totals({ thinkingTokens: 0 })))).not.toContain("⠿");
	});

	it("omits the input field without input", () => {
		expect(text(idle({}, totals({ inputTokens: 0, cacheReadTokens: 0 })))).toContain("14➤ | ↓6.2K");
	});
});

describe("number formatting", () => {
	it("formats token counts with K, M and B, dropping .0 (large token counts, round thousands)", () => {
		expect(formatTokens(987)).toBe("987");
		expect(formatTokens(12_345)).toBe("12.3K");
		expect(formatTokens(40_000)).toBe("40K");
		expect(formatTokens(999.6)).toBe("1K");
		expect(formatTokens(999_960)).toBe("1M");
		expect(formatTokens(2_345_678)).toBe("2.3M");
		expect(formatTokens(1_500_000_000)).toBe("1.5B");
		const session = totals({ inputTokens: 12_345, cacheReadTokens: 0, visibleOutputTokens: 987 });
		expect(text(idle({}, session))).toContain("↑12.3K | ↓987");
		expect(text(idle({}, totals({ inputTokens: 40_000, cacheReadTokens: 0 })))).toContain("↑40K |");
	});

	it("folds cache reads into the input with their share (cached input)", () => {
		const session = totals({ inputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 0 });
		expect(text(idle({}, session))).toContain("↑8.2K ◎98%");
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
