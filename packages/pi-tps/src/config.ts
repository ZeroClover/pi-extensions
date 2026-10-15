import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TICK_INTERVAL_MS, MAX_TICK_INTERVAL_MS, MIN_TICK_INTERVAL_MS } from "./constants.ts";
import { errorMessage } from "./files.ts";
import { finite, isRecord } from "./guards.ts";

export const CONFIG_FILE_NAME = "pi-tps.json";

/** A Pi theme colour token, following the active theme, or a fixed hex colour. */
export type ColorSpec = { kind: "token"; token: ThemeColor } | { kind: "hex"; hex: string };

export interface Threshold {
	min: number;
	color: ColorSpec;
}

export interface AnimationConfig {
	enabled: boolean;
	intervalMs: number;
	frames: string[];
}

/** Precedence levels of override keys, most specific first. */
const LEVEL = {
	exact: 0,
	providerGlob: 1,
	modelExact: 2,
	modelGlob: 3,
	providerAny: 4,
	any: 5,
} as const;

/**
 * How a live TPS or TTFT is coloured: `relative` by the live value as a percentage of the model's average (TTFT as
 * average over live), `absolute` by the value itself (TPS in tokens per second, TTFT in seconds).
 */
export type ColorMode = "relative" | "absolute";

export interface MetricSettings {
	mode: ColorMode;
	/** Thresholds in percent. */
	relative: Threshold[];
	/** Thresholds in tokens per second for TPS, in seconds for TTFT. */
	absolute: Threshold[];
}

export type Metric = "tps" | "ttft";

/** Colour settings of both live metrics. */
export type MetricConfig = Record<Metric, MetricSettings>;

/** The match rule of an override key. */
export interface OverrideRule {
	key: string;
	level: number;
	/** Literal characters of the model pattern; more literals means fewer wildcard-matched characters. */
	specificity: number;
	/** Lower-cased provider, or undefined when the key matches any provider. */
	provider?: string;
	model: RegExp;
}

export interface Override extends OverrideRule {
	/** The settings this override sets; every other leaf comes from the top level. */
	metrics: Partial<Record<Metric, Partial<MetricSettings>>>;
}

export interface TpsConfig extends MetricConfig {
	/** Initial visibility of the readout; `/tps` toggles it per session. */
	enabled: boolean;
	persist: boolean;
	/** When false, live counts use the raw estimate and the calibration directory is neither read nor written. */
	calibration: boolean;
	/** Drawn between fields. */
	separator: string;
	baseColor: ColorSpec;
	separatorColor: ColorSpec;
	/** Colour of the `↯` before a burst throughput. */
	burstColor: ColorSpec;
	animation: AnimationConfig;
	overrides: Override[];
}

export const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// A Record keyed by the union makes the compiler reject this table when Pi adds or removes a token.
const THEME_COLORS: Record<ThemeColor, true> = {
	accent: true,
	border: true,
	borderAccent: true,
	borderMuted: true,
	success: true,
	error: true,
	warning: true,
	muted: true,
	dim: true,
	text: true,
	thinkingText: true,
	scrollbarTrack: true,
	scrollbarThumb: true,
	searchMatchText: true,
	userMessageText: true,
	customMessageText: true,
	customMessageLabel: true,
	toolTitle: true,
	toolOutput: true,
	mdHeading: true,
	mdLink: true,
	mdLinkUrl: true,
	mdCode: true,
	mdCodeBlock: true,
	mdCodeBlockBorder: true,
	mdQuote: true,
	mdQuoteBorder: true,
	mdHr: true,
	mdListBullet: true,
	toolDiffAdded: true,
	toolDiffRemoved: true,
	toolDiffContext: true,
	syntaxComment: true,
	syntaxKeyword: true,
	syntaxFunction: true,
	syntaxVariable: true,
	syntaxString: true,
	syntaxNumber: true,
	syntaxType: true,
	syntaxOperator: true,
	syntaxPunctuation: true,
	thinkingOff: true,
	thinkingMinimal: true,
	thinkingLow: true,
	thinkingMedium: true,
	thinkingHigh: true,
	thinkingXhigh: true,
	thinkingMax: true,
	bashMode: true,
};

function isThemeColor(value: string): value is ThemeColor {
	return Object.hasOwn(THEME_COLORS, value);
}

const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

export function parseColorSpec(value: unknown): ColorSpec | undefined {
	if (typeof value !== "string") return undefined;
	if (isThemeColor(value)) return { kind: "token", token: value };
	if (HEX_COLOR.test(value)) return { kind: "hex", hex: value };
	return undefined;
}

const token = (name: ThemeColor): ColorSpec => ({ kind: "token", token: name });

export const DEFAULT_SEPARATOR = " | ";

function thresholdList(...entries: [number, ThemeColor][]): Threshold[] {
	return entries.map(([min, color]) => ({ min, color: token(color) }));
}

export function defaultConfig(): TpsConfig {
	return {
		enabled: true,
		persist: true,
		calibration: true,
		separator: DEFAULT_SEPARATOR,
		baseColor: token("dim"),
		separatorColor: token("borderMuted"),
		burstColor: token("mdLink"),
		animation: { enabled: true, intervalMs: DEFAULT_TICK_INTERVAL_MS, frames: [...DEFAULT_FRAMES] },
		tps: {
			mode: "relative",
			relative: thresholdList([0, "error"], [40, "warning"], [75, "success"]),
			absolute: thresholdList([0, "error"], [30, "warning"], [80, "success"]),
		},
		ttft: {
			mode: "relative",
			relative: thresholdList([0, "error"], [40, "warning"], [75, "success"]),
			absolute: thresholdList([0, "success"], [3, "warning"], [6, "error"]),
		},
		overrides: [],
	};
}

const COLOR_HINT = "expected a theme colour token (e.g. success, warning, error, accent, dim) or #rgb/#rrggbb";

/** Parses a threshold list. Returns undefined (after a warning) when the value is not a list at all. */
function parseThresholds(
	value: unknown,
	path: string,
	fallbackColor: ColorSpec,
	warn: (message: string) => void,
): Threshold[] | undefined {
	if (!Array.isArray(value)) {
		warn(`${path}: expected an array of { "min": number, "color": colour }`);
		return undefined;
	}
	const thresholds: Threshold[] = [];
	value.forEach((item: unknown, index) => {
		const itemPath = `${path}[${index}]`;
		if (!isRecord(item)) {
			warn(`${itemPath}: expected { "min": number, "color": colour }; entry ignored`);
			return;
		}
		const { min, color: rawColor } = item;
		if (!finite(min)) {
			warn(`${itemPath}.min: expected a number; entry ignored`);
			return;
		}
		let color = parseColorSpec(rawColor);
		if (!color) {
			warn(`${itemPath}.color: ${JSON.stringify(rawColor)} is not a colour, ${COLOR_HINT}; using baseColor`);
			color = fallbackColor;
		}
		thresholds.push({ min, color });
	});
	return thresholds.sort((a, b) => a.min - b.min);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiles a `*` glob into an anchored, case-insensitive pattern. */
export function compileGlob(pattern: string): RegExp {
	return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "i");
}

/** Parses an override key into its match rule, or returns a reason why it is invalid. */
export function parseOverrideKey(key: string): OverrideRule | string {
	const slash = key.indexOf("/");
	let provider: string | undefined;
	let model = key;
	if (slash !== -1) {
		const providerPart = key.slice(0, slash);
		model = key.slice(slash + 1);
		if (providerPart === "") return "provider part is empty";
		if (providerPart !== "*") {
			if (providerPart.includes("*")) return "provider part must be exact or *";
			provider = providerPart.toLowerCase();
		}
	}
	if (model === "") return "model part is empty";
	const glob = model.includes("*");
	let level: number;
	if (model === "*") level = provider === undefined ? LEVEL.any : LEVEL.providerAny;
	else if (provider !== undefined) level = glob ? LEVEL.providerGlob : LEVEL.exact;
	else level = glob ? LEVEL.modelGlob : LEVEL.modelExact;
	const rule: OverrideRule = {
		key,
		level,
		specificity: model.replaceAll("*", "").length,
		model: compileGlob(model),
	};
	if (provider !== undefined) rule.provider = provider;
	return rule;
}

/**
 * Colour settings for a provider and model: the single most specific matching override, with every leaf it does not
 * set taken from the top level. Overrides never combine.
 */
export function resolveMetrics(config: TpsConfig, provider: string, model: string): MetricConfig {
	const providerKey = provider.toLowerCase();
	let best: Override | undefined;
	for (const override of config.overrides) {
		if (override.provider !== undefined && override.provider !== providerKey) continue;
		if (!override.model.test(model)) continue;
		if (
			!best ||
			override.level < best.level ||
			(override.level === best.level && override.specificity > best.specificity)
		) {
			best = override;
		}
	}
	return { tps: { ...config.tps, ...best?.metrics.tps }, ttft: { ...config.ttft, ...best?.metrics.ttft } };
}

/** The colour of the highest threshold whose minimum is not greater than the value; none below the lowest. */
export function selectColor(thresholds: readonly Threshold[], value: number): ColorSpec | undefined {
	let selected: ColorSpec | undefined;
	for (const threshold of thresholds) {
		if (threshold.min <= value) selected = threshold.color;
	}
	return selected;
}

// Control characters (newlines, escapes) would break the footer line or inject terminal sequences.
function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

function isFrame(frame: unknown): frame is string {
	return typeof frame === "string" && frame.length > 0 && !hasControlCharacter(frame);
}

const KNOWN_KEYS = new Set([
	"enabled",
	"persist",
	"calibration",
	"separator",
	"baseColor",
	"separatorColor",
	"burstColor",
	"animation",
	"tps",
	"ttft",
	"overrides",
]);

const METRIC_KEYS = new Set(["mode", "relative", "absolute"]);
const METRICS: readonly Metric[] = ["tps", "ttft"];

/**
 * Parses the metric settings at `path`, keeping only the leaves that are valid. Undefined (after a warning) when the
 * value is not an object.
 */
function parseMetric(
	value: unknown,
	path: string,
	fallbackColor: ColorSpec,
	warn: (message: string) => void,
): Partial<MetricSettings> | undefined {
	if (!isRecord(value)) {
		warn(`${path}: expected an object with "mode", "relative" and "absolute"; ignored`);
		return undefined;
	}
	for (const key of Object.keys(value)) if (!METRIC_KEYS.has(key)) warn(`${path}.${key}: unknown setting ignored`);
	const settings: Partial<MetricSettings> = {};
	const { mode, relative, absolute } = value;
	if (mode === "relative" || mode === "absolute") settings.mode = mode;
	else if (mode !== undefined) warn(`${path}.mode: expected "relative" or "absolute"; ignored`);
	for (const [key, list] of [
		["relative", relative],
		["absolute", absolute],
	] as const) {
		if (list === undefined) continue;
		const parsed = parseThresholds(list, `${path}.${key}`, fallbackColor, warn);
		if (parsed) settings[key] = parsed;
	}
	return settings;
}

/** Parses one entry of `overrides`. Undefined (after a warning) when its key or value is unusable. */
function parseOverride(
	key: string,
	value: unknown,
	fallbackColor: ColorSpec,
	warn: (message: string) => void,
): Override | undefined {
	const path = `overrides["${key}"]`;
	const rule = parseOverrideKey(key);
	if (typeof rule === "string") {
		warn(`${path}: ${rule}; override ignored`);
		return undefined;
	}
	if (!isRecord(value)) {
		const hint = Array.isArray(value)
			? ' (a threshold list is the old format; use { "tps": { "absolute": [...] } })'
			: "";
		warn(`${path}: expected { "tps"?, "ttft"? }${hint}; override ignored`);
		return undefined;
	}
	const metrics: Override["metrics"] = {};
	for (const name of Object.keys(value)) {
		if (name !== "tps" && name !== "ttft") warn(`${path}.${name}: unknown setting ignored`);
	}
	for (const metric of METRICS) {
		if (value[metric] === undefined) continue;
		const parsed = parseMetric(value[metric], `${path}.${metric}`, fallbackColor, warn);
		if (parsed) metrics[metric] = parsed;
	}
	return { ...rule, metrics };
}

/**
 * Parses the configuration file content. Every problem produces one warning and falls back to the default of
 * that field only. `text` is undefined when the file does not exist.
 */
export function parseConfig(text: string | undefined, source: string): { config: TpsConfig; warnings: string[] } {
	const config = defaultConfig();
	const warnings: string[] = [];
	const warn = (message: string): void => {
		warnings.push(`pi-tps: ${source}: ${message}`);
	};
	if (text === undefined) return { config, warnings };
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		warn(`invalid JSON (${errorMessage(error)}); using defaults`);
		return { config, warnings };
	}
	if (!isRecord(json)) {
		warn("expected a JSON object; using defaults");
		return { config, warnings };
	}

	for (const key of Object.keys(json)) if (!KNOWN_KEYS.has(key)) warn(`${key}: unknown setting ignored`);

	for (const key of ["enabled", "persist", "calibration"] as const) {
		const value = json[key];
		if (value === undefined) continue;
		if (typeof value === "boolean") config[key] = value;
		else warn(`${key}: expected true or false; using ${config[key]}`);
	}

	const { separator, animation, overrides } = json;

	// baseColor comes first: it is the fallback of every invalid threshold colour.
	for (const key of ["baseColor", "separatorColor", "burstColor"] as const) {
		const value = json[key];
		if (value === undefined) continue;
		const parsed = parseColorSpec(value);
		if (parsed) config[key] = parsed;
		else warn(`${key}: ${JSON.stringify(value)} is not a colour, ${COLOR_HINT}; using the default`);
	}

	if (typeof separator === "string" && separator.length > 0 && !hasControlCharacter(separator)) {
		config.separator = separator;
	} else if (separator !== undefined) {
		warn(`separator: expected a non-empty string without control characters; using "${DEFAULT_SEPARATOR}"`);
	}

	if (animation !== undefined) {
		if (!isRecord(animation)) {
			warn("animation: expected an object; using defaults");
		} else {
			const { enabled, intervalMs, frames } = animation;
			if (typeof enabled === "boolean") config.animation.enabled = enabled;
			else if (enabled !== undefined) warn("animation.enabled: expected true or false; using true");
			if (typeof intervalMs === "number" && intervalMs >= MIN_TICK_INTERVAL_MS && intervalMs <= MAX_TICK_INTERVAL_MS) {
				config.animation.intervalMs = intervalMs;
			} else if (intervalMs !== undefined) {
				warn(
					`animation.intervalMs: expected a number from ${MIN_TICK_INTERVAL_MS} to ${MAX_TICK_INTERVAL_MS}; using ${DEFAULT_TICK_INTERVAL_MS}`,
				);
			}
			if (Array.isArray(frames) && frames.length > 0 && frames.every(isFrame)) {
				config.animation.frames = [...frames];
			} else if (frames !== undefined) {
				warn(
					"animation.frames: expected a non-empty array of non-empty strings without control characters; using the default spinner",
				);
			}
		}
	}

	for (const metric of METRICS) {
		const value = json[metric];
		if (value === undefined) continue;
		const parsed = parseMetric(value, metric, config.baseColor, warn);
		if (parsed) config[metric] = { ...config[metric], ...parsed };
	}

	if (overrides !== undefined) {
		if (!isRecord(overrides)) {
			warn('overrides: expected an object mapping match keys to { "tps"?, "ttft"? }');
		} else {
			for (const [key, value] of Object.entries(overrides)) {
				const override = parseOverride(key, value, config.baseColor, warn);
				if (override) config.overrides.push(override);
			}
		}
	}
	return { config, warnings };
}
