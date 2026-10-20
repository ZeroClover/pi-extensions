import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../src/config.ts";

const SOURCE = "/agent/pi-retry.json";

function load(json: unknown): ReturnType<typeof parseConfig> {
	return parseConfig(JSON.stringify(json), SOURCE);
}

describe("parseConfig", () => {
	it("No file: defaults apply and no warning is shown", () => {
		const { config, warnings } = parseConfig(undefined, SOURCE);
		expect(warnings).toEqual([]);
		expect(config).toEqual(defaultConfig());
		expect(config).toMatchObject({
			enabled: true,
			maxRetries: 10,
			baseDelayMs: 2000,
			maxBackoffMs: 60_000,
			maxRetryAfterMs: 1_800_000,
		});
	});

	it("Partial file: every other setting keeps its default", () => {
		const { config, warnings } = load({ maxRetries: 20 });
		expect(warnings).toEqual([]);
		expect(config).toEqual({ ...defaultConfig(), maxRetries: 20 });
	});

	it("Full file: all six values are applied", () => {
		const { config, warnings } = load({
			maxRetries: 5,
			baseDelayMs: 1000,
			maxBackoffMs: 30000,
			maxRetryAfterMs: 600000,
			patterns: { retryable: ["backend saturated"], nonRetryable: ["tenant suspended"] },
		});
		expect(warnings).toEqual([]);
		expect(config).toMatchObject({ maxRetries: 5, baseDelayMs: 1000, maxBackoffMs: 30000, maxRetryAfterMs: 600000 });
		expect(config.patterns.retryable.map(String)).toEqual(["/backend saturated/i"]);
		expect(config.patterns.nonRetryable.map(String)).toEqual(["/tenant suspended/i"]);
	});

	it("applies enabled: false", () => {
		expect(load({ enabled: false }).config.enabled).toBe(false);
	});

	it("Invalid JSON: all defaults apply and one warning names the file and the parse error", () => {
		const { config, warnings } = parseConfig("{ maxRetries: 3", SOURCE);
		expect(config).toEqual(defaultConfig());
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(SOURCE);
		expect(warnings[0]).toMatch(/invalid JSON \(.+\)/);
	});

	it("warns once for a non-object top level", () => {
		const { config, warnings } = load([1, 2]);
		expect(config).toEqual(defaultConfig());
		expect(warnings).toEqual([`pi-retry: ${SOURCE}: expected a JSON object; using defaults`]);
	});

	it("Out-of-range value: the default applies and one warning names the field", () => {
		const { config, warnings } = load({ maxRetries: -1 });
		expect(config.maxRetries).toBe(10);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("maxRetries");
	});

	it.each([
		["maxRetries", 1001],
		["maxRetries", 2.5],
		["baseDelayMs", 99],
		["baseDelayMs", 3_600_001],
		["maxBackoffMs", 86_400_001],
		["maxRetryAfterMs", -1],
		["maxRetryAfterMs", "30m"],
		["enabled", "yes"],
	])("rejects %s = %j with one warning and keeps the default", (key, value) => {
		const { config, warnings } = load({ [key]: value });
		expect(config).toEqual(defaultConfig());
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(key);
	});

	it("accepts the range limits", () => {
		const { config, warnings } = load({
			maxRetries: 0,
			baseDelayMs: 100,
			maxBackoffMs: 86_400_000,
			maxRetryAfterMs: 0,
		});
		expect(warnings).toEqual([]);
		expect(config).toMatchObject({ maxRetries: 0, baseDelayMs: 100, maxBackoffMs: 86_400_000, maxRetryAfterMs: 0 });
	});

	it("Cap below base: maxBackoffMs is raised and one warning names it", () => {
		const { config, warnings } = load({ baseDelayMs: 5000, maxBackoffMs: 1000 });
		expect(config.baseDelayMs).toBe(5000);
		expect(config.maxBackoffMs).toBe(5000);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("maxBackoffMs");
	});

	it("raises the default cap silently when only the base exceeds it", () => {
		const { config, warnings } = load({ baseDelayMs: 120_000 });
		expect(config.maxBackoffMs).toBe(120_000);
		expect(warnings).toEqual([]);
	});

	it("Invalid pattern: that entry is ignored with one warning and the others are kept", () => {
		const { config, warnings } = load({ patterns: { retryable: ["(", "backend saturated"] } });
		expect(config.patterns.retryable.map(String)).toEqual(["/backend saturated/i"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"("');
	});

	it("compiles patterns case-insensitively", () => {
		const { config } = load({ patterns: { nonRetryable: ["Tenant Suspended"] } });
		expect(config.patterns.nonRetryable[0]?.test("503 tenant suspended")).toBe(true);
	});

	it("warns about non-string pattern entries, non-array pattern lists and a non-object patterns value", () => {
		expect(load({ patterns: { retryable: [1, "ok"] } }).warnings).toHaveLength(1);
		expect(load({ patterns: { retryable: "ok" } }).warnings).toHaveLength(1);
		expect(load({ patterns: ["ok"] }).warnings).toHaveLength(1);
		expect(load({ patterns: { sometimes: [] } }).warnings).toEqual([
			`pi-retry: ${SOURCE}: patterns.sometimes: unknown setting ignored`,
		]);
	});

	it("Unknown key: one warning says it is unknown and it is ignored", () => {
		const { config, warnings } = load({ jitter: 0.5 });
		expect(config).toEqual(defaultConfig());
		expect(warnings).toEqual([`pi-retry: ${SOURCE}: jitter: unknown setting ignored`]);
	});

	it("produces one warning per problem", () => {
		const { config, warnings } = load({ jitter: 1, maxRetries: "many", patterns: { retryable: ["("] } });
		expect(warnings).toHaveLength(3);
		expect(config.maxRetries).toBe(10);
	});

	it("loads the README example without warnings", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const example = /```json\n([\s\S]*?)\n```/.exec(readme)?.[1];
		expect(example).toBeDefined();
		const { warnings } = parseConfig(example, SOURCE);
		expect(warnings).toEqual([]);
	});
});
