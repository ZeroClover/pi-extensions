import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type ColorSpec,
	compileGlob,
	defaultConfig,
	parseConfig,
	parseOverrideKey,
	resolveMetrics,
	selectColor,
	type Threshold,
} from "../src/config.ts";

const SOURCE = "/agent/pi-tps.json";

function load(json: unknown): ReturnType<typeof parseConfig> {
	return parseConfig(JSON.stringify(json), SOURCE);
}

/** A threshold list as `min → colour token` pairs, for compact assertions. */
function bands(list: readonly Threshold[]): [number, string][] {
	return list.map(({ min, color }) => [min, color.kind === "token" ? color.token : color.hex]);
}

describe("parseConfig", () => {
	it("applies defaults silently when the file is missing", () => {
		const { config, warnings } = parseConfig(undefined, SOURCE);
		expect(warnings).toEqual([]);
		expect(config).toEqual(defaultConfig());
		expect(config.persist).toBe(true);
		expect(config.animation.intervalMs).toBe(100);
		expect(config).toMatchObject({
			calibration: true,
			separator: " | ",
			baseColor: { kind: "token", token: "dim" },
			separatorColor: { kind: "token", token: "borderMuted" },
			burstColor: { kind: "token", token: "mdLink" },
		});
		expect(config.tps.mode).toBe("relative");
		expect(config.ttft.mode).toBe("relative");
	});

	it("has the four default threshold lists", () => {
		const { tps, ttft } = defaultConfig();
		const relative = [
			[0, "error"],
			[40, "warning"],
			[75, "success"],
		];
		expect(bands(tps.relative)).toEqual(relative);
		expect(bands(ttft.relative)).toEqual(relative);
		expect(bands(tps.absolute)).toEqual([
			[0, "error"],
			[30, "warning"],
			[80, "success"],
		]);
		expect(bands(ttft.absolute)).toEqual([
			[0, "success"],
			[3, "warning"],
			[6, "error"],
		]);
	});

	it("keeps every other default for a partial file (partial file)", () => {
		const { config, warnings } = load({ separator: " · " });
		expect(warnings).toEqual([]);
		expect(config).toEqual({ ...defaultConfig(), separator: " · " });
	});

	it("parses calibration, the colours and the metric settings", () => {
		const { config, warnings } = load({
			calibration: false,
			separatorColor: "#444",
			burstColor: "accent",
			tps: { mode: "absolute", absolute: [{ min: 10, color: "success" }] },
			ttft: { relative: [{ min: 50, color: "warning" }] },
		});
		expect(warnings).toEqual([]);
		expect(config.calibration).toBe(false);
		expect(config.separatorColor).toEqual({ kind: "hex", hex: "#444" });
		expect(config.burstColor).toEqual({ kind: "token", token: "accent" });
		expect(config.tps.mode).toBe("absolute");
		expect(bands(config.tps.absolute)).toEqual([[10, "success"]]);
		expect(config.tps.relative).toEqual(defaultConfig().tps.relative);
		expect(bands(config.ttft.relative)).toEqual([[50, "warning"]]);
		expect(config.ttft.mode).toBe("relative");
		expect(config.ttft.absolute).toEqual(defaultConfig().ttft.absolute);
	});

	it("warns once naming the file and the parse error on invalid JSON", () => {
		const { config, warnings } = parseConfig("{ nope", SOURCE);
		expect(config).toEqual(defaultConfig());
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(SOURCE);
		expect(warnings[0]).toContain("invalid JSON");
	});

	it("rejects a non-object top level", () => {
		const { config, warnings } = load([1, 2]);
		expect(config).toEqual(defaultConfig());
		expect(warnings).toHaveLength(1);
	});

	it("falls back to the default interval and names animation.intervalMs", () => {
		const { config, warnings } = load({ animation: { intervalMs: "fast", enabled: false } });
		expect(config.animation.intervalMs).toBe(100);
		expect(config.animation.enabled).toBe(false);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("animation.intervalMs");
	});

	it("rejects intervals below 50 ms", () => {
		expect(load({ animation: { intervalMs: 10 } }).config.animation.intervalMs).toBe(100);
	});

	it("rejects intervals above 1000 ms (interval out of range)", () => {
		const { config, warnings } = load({ animation: { intervalMs: 2147483648 } });
		expect(config.animation.intervalMs).toBe(100);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("animation.intervalMs");
		expect(load({ animation: { intervalMs: 1000 } }).config.animation.intervalMs).toBe(1000);
	});

	it("rejects frames with control characters (frame with a newline)", () => {
		const { config, warnings } = load({ animation: { frames: ["a\nb", "c"] } });
		expect(config.animation.frames).toEqual(defaultConfig().animation.frames);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("animation.frames");
		expect(load({ animation: { frames: ["\u001b[31m"] } }).warnings).toHaveLength(1);
	});

	it("keeps file order for thresholds with equal min, so the later one wins", () => {
		const { config } = load({
			tps: {
				absolute: [
					{ min: 10, color: "error" },
					{ min: 10, color: "success" },
				],
			},
		});
		expect(config.tps.absolute.map((t) => t.color)).toEqual([
			{ kind: "token", token: "error" },
			{ kind: "token", token: "success" },
		]);
	});

	it("rejects an unknown colour token and uses the default colour for that entry", () => {
		const { config, warnings } = load({
			ttft: {
				absolute: [
					{ min: 0, color: "purple" },
					{ min: 50, color: "#ff8800" },
				],
			},
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("ttft.absolute[0].color");
		expect(config.ttft.absolute).toEqual([
			{ min: 0, color: { kind: "token", token: "dim" } },
			{ min: 50, color: { kind: "hex", hex: "#ff8800" } },
		]);
	});

	it("rejects a bad baseColor", () => {
		const { config, warnings } = load({ baseColor: "#12" });
		expect(config.baseColor).toEqual({ kind: "token", token: "dim" });
		expect(warnings[0]).toContain("baseColor");
	});

	it("rejects a bad separatorColor or burstColor", () => {
		const { config, warnings } = load({ separatorColor: "grey", burstColor: 3 });
		expect(config.separatorColor).toEqual({ kind: "token", token: "borderMuted" });
		expect(config.burstColor).toEqual({ kind: "token", token: "mdLink" });
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("separatorColor");
		expect(warnings[1]).toContain("burstColor");
	});

	it("rejects a separator with a control character (separator with a newline)", () => {
		const { config, warnings } = load({ separator: "\n" });
		expect(config.separator).toBe(" | ");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("separator");
		expect(load({ separator: "" }).warnings).toHaveLength(1);
		expect(load({ separator: 1 }).warnings).toHaveLength(1);
	});

	it("falls back to relative mode for an unknown mode (unknown mode)", () => {
		const { config, warnings } = load({ tps: { mode: "fast" } });
		expect(config.tps.mode).toBe("relative");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("tps.mode");
	});

	it("warns about unknown keys and non-object metric settings", () => {
		const { config, warnings } = load({ tps: { mode: "absolute", min: 3 }, ttft: [] });
		expect(config.tps.mode).toBe("absolute");
		expect(config.ttft).toEqual(defaultConfig().ttft);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("tps.min");
		expect(warnings[1]).toContain("ttft");
	});

	it("rejects a non-boolean calibration", () => {
		const { config, warnings } = load({ calibration: "off" });
		expect(config.calibration).toBe(true);
		expect(warnings[0]).toContain("calibration");
	});

	it("rejects a non-boolean persist", () => {
		const { config, warnings } = load({ persist: "no" });
		expect(config.persist).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("persist");
	});

	it("warns about a label style, which this version removed (symbol labels)", () => {
		const { config, warnings } = load({ labels: "symbols" });
		expect(config).toEqual(defaultConfig());
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("labels: unknown setting");
	});

	it("warns about an unknown label style as an unknown setting (unknown label style)", () => {
		const { config, warnings } = load({ labels: "emoji" });
		expect(config).toEqual(defaultConfig());
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("labels: unknown setting");
	});

	it("warns once about each removed key", () => {
		const { config, warnings } = load({ summaryMode: "session", thresholds: [{ min: 0, color: "error" }] });
		expect(config).toEqual(defaultConfig());
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("summaryMode: unknown setting");
		expect(warnings[1]).toContain("thresholds: unknown setting");
	});

	it("accepts persist false", () => {
		expect(load({ persist: false }).config.persist).toBe(false);
	});

	it("sorts unsorted thresholds (unsorted input)", () => {
		const { config } = load({
			tps: {
				absolute: [
					{ min: 80, color: "success" },
					{ min: 0, color: "error" },
					{ min: 30, color: "warning" },
				],
			},
		});
		expect(config.tps.absolute.map((t) => t.min)).toEqual([0, 30, 80]);
	});

	it("drops threshold entries without a numeric min", () => {
		const { config, warnings } = load({ tps: { relative: [{ color: "error" }, { min: 10, color: "error" }] } });
		expect(config.tps.relative).toHaveLength(1);
		expect(warnings[0]).toContain("tps.relative[0].min");
	});

	it("colours a TTFT at a boundary by the default absolute list (TTFT at a boundary)", () => {
		const { absolute } = defaultConfig().ttft;
		expect(selectColor(absolute, 2.9)).toEqual({ kind: "token", token: "success" });
		expect(selectColor(absolute, 3.0)).toEqual({ kind: "token", token: "warning" });
	});

	it("warns about unknown settings and invalid frames", () => {
		const { config, warnings } = load({ colour: "red", animation: { frames: [] } });
		expect(config.animation.frames).toEqual(defaultConfig().animation.frames);
		expect(warnings).toHaveLength(2);
	});

	it("never disables the readout because of bad input", () => {
		expect(load({ enabled: "yes" }).config.enabled).toBe(true);
	});
});

describe("README example", () => {
	it("loads without warnings", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const example = /<!-- example-config[^>]*-->\s*```json\n([\s\S]*?)```/.exec(readme)?.[1];
		expect(example).toBeDefined();
		const { config, warnings } = parseConfig(example, "README.md");
		expect(warnings).toEqual([]);
		expect(config.separator).toBe(" · ");
		expect(config.overrides).toHaveLength(3);
		const ollama = resolveMetrics(config, "ollama", "llama3");
		expect(ollama.tps.mode).toBe("absolute");
		expect(ollama.tps.absolute[0]?.color).toEqual({ kind: "hex", hex: "#ff8800" });
		expect(ollama.ttft).toEqual(config.ttft);
	});
});

describe("override keys", () => {
	it("rejects globbed or empty provider parts", () => {
		expect(parseOverrideKey("anth*/claude")).toBeTypeOf("string");
		expect(parseOverrideKey("/claude")).toBeTypeOf("string");
		expect(parseOverrideKey("anthropic/")).toBeTypeOf("string");
	});

	it("warns and skips invalid keys", () => {
		const { config, warnings } = load({ overrides: { "a*/b": {}, ok: {} } });
		expect(config.overrides.map((o) => o.key)).toEqual(["ok"]);
		expect(warnings).toHaveLength(1);
	});

	it("ignores a threshold list as an override value with one warning (override in the old format)", () => {
		const { config, warnings } = load({ overrides: { "gpt-5*": [{ min: 0, color: "warning" }], ok: {} } });
		expect(config.overrides.map((o) => o.key)).toEqual(["ok"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('overrides["gpt-5*"]');
	});

	it("warns about unknown keys inside an override", () => {
		const { config, warnings } = load({ overrides: { ok: { tps: { mode: "absolute" }, thresholds: [] } } });
		expect(config.overrides[0]?.metrics).toEqual({ tps: { mode: "absolute" } });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('overrides["ok"].thresholds');
	});

	it("matches globs case-insensitively", () => {
		expect(compileGlob("claude-*").test("Claude-Sonnet-4")).toBe(true);
		expect(compileGlob("gpt-5.1").test("gpt-501")).toBe(false);
	});
});

describe("resolveMetrics", () => {
	const level = (name: string) => ({ tps: { absolute: [{ min: 0, color: name }] } });
	const config = load({
		overrides: {
			"anthropic/claude-sonnet-4": level("accent"),
			"anthropic/claude-*": level("success"),
			"claude-*": level("warning"),
			"claude-opus-4": level("error"),
			"gpt-5*": level("muted"),
			"openai/*": level("text"),
			"*": level("border"),
		},
	}).config;
	const colorName = (color: ColorSpec | undefined) => (color?.kind === "token" ? color.token : color?.hex);
	const resolved = (provider: string, model: string) =>
		colorName(resolveMetrics(config, provider, model).tps.absolute[0]?.color);

	it("matches a glob on the model", () => {
		expect(resolved("anthropic", "claude-haiku-4")).toBe("success");
	});

	it("matches a model-only key across providers", () => {
		expect(resolved("openrouter", "gpt-5-mini")).toBe("muted");
	});

	it("prefers exact provider/model over provider/glob (exact beats glob)", () => {
		expect(resolved("anthropic", "claude-sonnet-4")).toBe("accent");
	});

	it("prefers provider/glob over model-only keys (provider-scoped glob beats model-only)", () => {
		expect(resolved("anthropic", "claude-opus-4")).toBe("success");
	});

	it("prefers model-only exact over model-only glob", () => {
		expect(resolved("bedrock", "claude-opus-4")).toBe("error");
		expect(resolved("bedrock", "claude-haiku-4")).toBe("warning");
	});

	it("prefers model-only keys over provider/*", () => {
		expect(resolved("openai", "gpt-5")).toBe("muted");
		expect(resolved("openai", "o3")).toBe("text");
	});

	it("is case-insensitive", () => {
		expect(resolved("Anthropic", "CLAUDE-SONNET-4")).toBe("accent");
	});

	it("falls back to * and then to the top-level settings", () => {
		expect(resolved("mistral", "large")).toBe("border");
		const global = defaultConfig();
		expect(resolveMetrics(global, "mistral", "large")).toEqual({ tps: global.tps, ttft: global.ttft });
	});

	it("prefers the first of equally specific patterns", () => {
		const tie = load({ overrides: { "claude-*-4": level("warning"), "claude-4-*": level("error") } }).config;
		expect(colorName(resolveMetrics(tie, "x", "claude-4-4").tps.absolute[0]?.color)).toBe("warning");
	});

	it("prefers the more specific pattern within one level", () => {
		const specific = load({ overrides: { "claude-*": level("warning"), "claude-opus-*": level("error") } }).config;
		expect(colorName(resolveMetrics(specific, "x", "claude-opus-4-1").tps.absolute[0]?.color)).toBe("error");
	});

	it("fills every leaf the override does not set from the top level (partial override)", () => {
		const partial = load({
			tps: { mode: "absolute" },
			ttft: { mode: "absolute" },
			overrides: { "anthropic/*": level("accent") },
		}).config;
		const metrics = resolveMetrics(partial, "anthropic", "claude-opus-4");
		expect(colorName(metrics.tps.absolute[0]?.color)).toBe("accent");
		expect(metrics.tps.mode).toBe("absolute");
		expect(metrics.tps.relative).toEqual(partial.tps.relative);
		expect(metrics.ttft).toEqual(partial.ttft);
	});

	it("applies only the most specific override (overrides do not combine)", () => {
		const layered = load({
			overrides: {
				"anthropic/*": { tps: { mode: "absolute" } },
				"anthropic/claude-opus-*": level("accent"),
			},
		}).config;
		const metrics = resolveMetrics(layered, "anthropic", "claude-opus-4");
		expect(colorName(metrics.tps.absolute[0]?.color)).toBe("accent");
		expect(metrics.tps.mode).toBe("relative");
		expect(resolveMetrics(layered, "anthropic", "claude-sonnet-4").tps.mode).toBe("absolute");
	});
});
