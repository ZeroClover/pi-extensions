import { type Color, colorToHex } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type MetricConfig, type MetricSettings, parseConfig, resolveMetrics, selectColor } from "../src/config.ts";
import { formatSnapshot, type Line, tpsColor, ttftColor } from "../src/format.ts";
import { type LineStyle, paint, renderLine, StatusWriter, type ThemeLike } from "../src/render.ts";
import type { Averages, LiveSnapshot } from "../src/telemetry.ts";

const theme: ThemeLike = {
	fg: (color, text) => `<${color}>${text}`,
	style: (text, options: { fg: Color }) => `<${colorToHex(options.fg)}>${text}`,
};

function configOf(json: unknown) {
	const { config, warnings } = parseConfig(JSON.stringify(json), "test");
	expect(warnings).toEqual([]);
	return config;
}

const DEFAULTS = configOf({});
const METRICS: MetricConfig = { tps: DEFAULTS.tps, ttft: DEFAULTS.ttft };

/** The colour token or hex a role resolves to under the defaults, `base` for the base colour. */
function colorName(role: ReturnType<typeof tpsColor>): string {
	if (typeof role === "string") return role;
	return role.color.kind === "token" ? role.color.token : role.color.hex;
}

const tps = (settings: MetricSettings, live: number, average: Averages) => colorName(tpsColor(settings, live, average));
const ttft = (settings: MetricSettings, liveMs: number, average: Averages) =>
	colorName(ttftColor(settings, liveMs, average));

const streaming: LiveSnapshot = {
	phase: "streaming",
	provider: "p",
	model: "m",
	request: 1,
	elapsedMs: 6000,
	ttftMs: 600,
	liveTps: 68.3,
	outputTokens: 1200,
	thinking: "none",
	average: { tps: 52.3, ttftMs: 1100 },
};

function render(line: Line, style: LineStyle = DEFAULTS): string {
	return renderLine(line, theme, style);
}

describe("relative colour mode", () => {
	it("colours the live TPS by its share of the average (default bands)", () => {
		const average = { tps: 52.3 };
		expect(tps(DEFAULTS.tps, 48.6, average)).toBe("success");
		expect(tps(DEFAULTS.tps, 31.0, average)).toBe("warning");
		expect(tps(DEFAULTS.tps, 18.2, average)).toBe("error");
	});

	it("colours the live TTFT by the average over the live value (TTFT counting up)", () => {
		const average = { ttftMs: 1100 };
		expect(ttft(DEFAULTS.ttft, 600, average)).toBe("success");
		expect(ttft(DEFAULTS.ttft, 2000, average)).toBe("warning");
		expect(ttft(DEFAULTS.ttft, 3400, average)).toBe("error");
		expect(ttft(DEFAULTS.ttft, 0, average)).toBe("success");
	});

	it("judges a slow model by its own average (slow model at its usual speed)", () => {
		expect(tps(DEFAULTS.tps, 24.1, { tps: 26 })).toBe("success");
		expect(tps({ ...DEFAULTS.tps, mode: "absolute" }, 24.1, { tps: 26 })).toBe("error");
	});
});

describe("absolute colour mode", () => {
	it("colours the live TPS by tokens per second (absolute TPS)", () => {
		expect(tps({ ...DEFAULTS.tps, mode: "absolute" }, 48.6, { tps: 52.3 })).toBe("warning");
	});

	it("colours the live TTFT by seconds", () => {
		const absolute = { ...DEFAULTS.ttft, mode: "absolute" as const };
		expect(ttft(absolute, 2900, { ttftMs: 100 })).toBe("success");
		expect(ttft(absolute, 3000, { ttftMs: 100 })).toBe("warning");
		expect(ttft(absolute, 6000, { ttftMs: 100 })).toBe("error");
	});

	it("applies in relative mode while the model has no average (first request in relative mode)", () => {
		expect(ttft(DEFAULTS.ttft, 1400, {})).toBe("success");
		expect(tps(DEFAULTS.tps, 48.6, {})).toBe("warning");
	});

	it("applies to TPS in relative mode while the only average is a burst throughput", () => {
		expect(tps(DEFAULTS.tps, 48.6, { burstTps: 225 })).toBe("warning");
	});
});

describe("renderLine", () => {
	it("paints the live figures, the averages, the separators and the spinner (default separator)", () => {
		const line = formatSnapshot(streaming, "⠼", METRICS);
		expect(render(line)).toBe(
			"<dim>⠼ <success>68.3<dim> (<dim>x̄52.3<dim>)<success> TPS<borderMuted> | " +
				"<success>TTFT 0.6s<dim> (x̄1.1s)<borderMuted> | <dim>↓1.2K",
		);
	});

	it("joins fields with a configured separator (custom separator)", () => {
		const style = configOf({ separator: " · ", separatorColor: "#888888" });
		const line = formatSnapshot(streaming, "⠼", METRICS);
		expect(render(line, style)).toContain("<#888888> · ");
		expect(render(line, style).replace(/<[^>]*>/g, "")).toBe("⠼ 68.3 (x̄52.3) TPS · TTFT 0.6s (x̄1.1s) · ↓1.2K");
	});

	it("colours only the outcome marker and the burst sign when idle (idle line)", () => {
		const line = formatSnapshot(
			{
				phase: "idle",
				average: { burstTps: 225, ttftMs: 4000 },
				session: {
					runs: 2,
					elapsedMs: 9100,
					requests: 2,
					inputTokens: 6200,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					visibleOutputTokens: 1800,
					thinkingTokens: 0,
					lastAborted: false,
				},
			},
			"",
			METRICS,
		);
		const colors = [...render(line).matchAll(/<([^>]*)>([^<]*)/g)].map(([, color, text]) => [color, text]);
		const colored = colors.filter(([color]) => color !== "dim" && color !== "borderMuted");
		// The space after the marker is unpainted, so it follows the marker's text.
		expect(colored).toEqual([
			["success", "✓ "],
			["mdLink", "↯"],
		]);
		const failed = formatSnapshot(
			{ phase: "idle", average: {}, session: { ...failedTotals(), lastAborted: true } },
			"",
			METRICS,
		);
		expect(render(failed)).toMatch(/^<error>✗ /);
	});

	it("keeps the live TTFT in the base colour while hidden thinking is open (hidden thinking)", () => {
		const { ttftMs: _ttft, liveTps: _tps, ...rest } = streaming;
		const hidden: LiveSnapshot = { ...rest, elapsedMs: 4200, outputTokens: 0, thinking: "hidden", thinkingMs: 4000 };
		const rendered = render(formatSnapshot(hidden, "⠧", METRICS));
		expect(rendered).toContain("<dim>TTFT 4.2s<dim> (x̄1.1s)");
		expect(rendered).toContain("<dim>-<dim> (<dim>x̄52.3<dim>)<dim> TPS");
		// Once content arrives the TTFT freezes and is coloured again: 1100 / 4300 is 26 %.
		const arrived = render(formatSnapshot({ ...hidden, ttftMs: 4300 }, "⠧", METRICS));
		expect(arrived).toContain("<error>TTFT 4.3s");
	});

	it("uses the base colour below the lowest threshold (value below the lowest threshold)", () => {
		const config = configOf({ tps: { mode: "absolute", absolute: [{ min: 10, color: "error" }] } });
		expect(selectColor(config.tps.absolute, 4)).toBeUndefined();
		const slow = formatSnapshot({ ...streaming, liveTps: 4 }, "⠼", { tps: config.tps, ttft: config.ttft });
		expect(render(slow)).toContain("<dim>4.0<dim> (");
		expect(selectColor([], 50)).toBeUndefined();
	});

	it("renders a streaming line with an override's mode and colours", () => {
		const config = configOf({
			separatorColor: "muted",
			overrides: {
				"anthropic/*": {
					tps: { mode: "absolute", absolute: [{ min: 0, color: "#ff8800" }] },
					ttft: { relative: [{ min: 0, color: "accent" }] },
				},
			},
		});
		const metrics = resolveMetrics(config, "anthropic", "claude-sonnet-4");
		const line = formatSnapshot({ ...streaming, provider: "anthropic", model: "claude-sonnet-4" }, "⠼", metrics);
		expect(renderLine(line, theme, config)).toBe(
			"<dim>⠼ <#ff8800>68.3<dim> (<dim>x̄52.3<dim>)<#ff8800> TPS<muted> | <accent>TTFT 0.6s<dim> (x̄1.1s)<muted> | <dim>↓1.2K",
		);
	});

	it("renders hex colours through the theme's colour mode", () => {
		expect(paint(theme, { kind: "hex", hex: "#f80" }, "x")).toBe("<#ff8800>x");
	});
});

function failedTotals() {
	return {
		runs: 1,
		elapsedMs: 5000,
		requests: 1,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		visibleOutputTokens: 64,
		thinkingTokens: 0,
	};
}

describe("StatusWriter", () => {
	it("writes only changed text", () => {
		const written: (string | undefined)[] = [];
		const writer = new StatusWriter();
		const write = (text: string | undefined) => written.push(text);
		expect(writer.set("a", write)).toBe(true);
		expect(writer.set("a", write)).toBe(false);
		writer.set(undefined, write);
		writer.set(undefined, write);
		writer.set("b", write);
		expect(written).toEqual(["a", undefined, "b"]);
	});
});
