import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileGlob, defaultConfig, parseConfig, parseOverrideKey, resolveThresholds } from "../src/config.ts";

const SOURCE = "/agent/pi-tps.json";

function load(json: unknown): ReturnType<typeof parseConfig> {
	return parseConfig(JSON.stringify(json), SOURCE);
}

describe("parseConfig", () => {
	it("applies defaults silently when the file is missing", () => {
		const { config, warnings } = parseConfig(undefined, SOURCE);
		expect(warnings).toEqual([]);
		expect(config).toEqual(defaultConfig());
		expect(config.persist).toBe(true);
		expect(config.animation.intervalMs).toBe(100);
		expect(config.thresholds.map((t) => t.min)).toEqual([0, 30, 80]);
	});

	it("keeps every other default for a partial file", () => {
		const { config, warnings } = load({ summaryMode: "session" });
		expect(warnings).toEqual([]);
		expect(config).toEqual({ ...defaultConfig(), summaryMode: "session" });
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

	it("rejects an unknown colour token and uses the default colour for that entry", () => {
		const { config, warnings } = load({
			thresholds: [
				{ min: 0, color: "purple" },
				{ min: 50, color: "#ff8800" },
			],
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("thresholds[0].color");
		expect(config.thresholds).toEqual([
			{ min: 0, color: { kind: "token", token: "dim" } },
			{ min: 50, color: { kind: "hex", hex: "#ff8800" } },
		]);
	});

	it("rejects a bad baseColor", () => {
		const { config, warnings } = load({ baseColor: "#12" });
		expect(config.baseColor).toEqual({ kind: "token", token: "dim" });
		expect(warnings[0]).toContain("baseColor");
	});

	it("rejects a non-boolean persist", () => {
		const { config, warnings } = load({ persist: "no" });
		expect(config.persist).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("persist");
	});

	it("accepts persist false", () => {
		expect(load({ persist: false }).config.persist).toBe(false);
	});

	it("sorts unsorted thresholds", () => {
		const { config } = load({
			thresholds: [
				{ min: 80, color: "success" },
				{ min: 0, color: "error" },
				{ min: 30, color: "warning" },
			],
		});
		expect(config.thresholds.map((t) => t.min)).toEqual([0, 30, 80]);
	});

	it("drops threshold entries without a numeric min", () => {
		const { config, warnings } = load({ thresholds: [{ color: "error" }, { min: 10, color: "error" }] });
		expect(config.thresholds).toHaveLength(1);
		expect(warnings[0]).toContain("thresholds[0].min");
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
		expect(config.summaryMode).toBe("session");
		expect(config.overrides).toHaveLength(3);
		expect(resolveThresholds(config, "ollama", "llama3")[0]?.color).toEqual({ kind: "hex", hex: "#ff8800" });
	});
});

describe("override keys", () => {
	it("rejects globbed or empty provider parts", () => {
		expect(parseOverrideKey("anth*/claude")).toBeTypeOf("string");
		expect(parseOverrideKey("/claude")).toBeTypeOf("string");
		expect(parseOverrideKey("anthropic/")).toBeTypeOf("string");
	});

	it("warns and skips invalid keys", () => {
		const { config, warnings } = load({ overrides: { "a*/b": [], ok: [] } });
		expect(config.overrides.map((o) => o.key)).toEqual(["ok"]);
		expect(warnings).toHaveLength(1);
	});

	it("matches globs case-insensitively", () => {
		expect(compileGlob("claude-*").test("Claude-Sonnet-4")).toBe(true);
		expect(compileGlob("gpt-5.1").test("gpt-501")).toBe(false);
	});
});

describe("resolveThresholds", () => {
	const level = (name: string) => [{ min: 0, color: name }];
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
	const resolved = (provider: string, model: string) => {
		const color = resolveThresholds(config, provider, model)[0]?.color;
		return color?.kind === "token" ? color.token : color?.hex;
	};

	it("matches a glob on the model", () => {
		expect(resolved("anthropic", "claude-haiku-4")).toBe("success");
	});

	it("matches a model-only key across providers", () => {
		expect(resolved("openrouter", "gpt-5-mini")).toBe("muted");
	});

	it("prefers exact provider/model over provider/glob", () => {
		expect(resolved("anthropic", "claude-sonnet-4")).toBe("accent");
	});

	it("prefers provider/glob over model-only keys", () => {
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

	it("falls back to * and then to the global thresholds", () => {
		expect(resolved("mistral", "large")).toBe("border");
		const global = defaultConfig();
		expect(resolveThresholds(global, "mistral", "large")).toBe(global.thresholds);
	});

	it("prefers the more specific pattern within one level", () => {
		const specific = load({ overrides: { "claude-*": level("warning"), "claude-opus-*": level("error") } }).config;
		expect(resolveThresholds(specific, "x", "claude-opus-4-1")[0]?.color).toEqual({ kind: "token", token: "error" });
	});
});
