import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TICK_INTERVAL_MS, MIN_TICK_INTERVAL_MS } from "./constants.ts";
import { errorMessage } from "./files.ts";
import type { SummaryMode } from "./telemetry.ts";

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

export interface Override {
	key: string;
	level: number;
	/** Literal characters of the model pattern; more literals means fewer wildcard-matched characters. */
	specificity: number;
	/** Lower-cased provider, or undefined when the key matches any provider. */
	provider?: string;
	model: RegExp;
	thresholds: Threshold[];
}

export interface TpsConfig {
	/** Initial visibility of the readout; `/tps` toggles it per session. */
	enabled: boolean;
	persist: boolean;
	summaryMode: SummaryMode;
	baseColor: ColorSpec;
	animation: AnimationConfig;
	thresholds: Threshold[];
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

export function defaultConfig(): TpsConfig {
	return {
		enabled: true,
		persist: true,
		summaryMode: "last",
		baseColor: token("dim"),
		animation: { enabled: true, intervalMs: DEFAULT_TICK_INTERVAL_MS, frames: [...DEFAULT_FRAMES] },
		thresholds: [
			{ min: 0, color: token("error") },
			{ min: 30, color: token("warning") },
			{ min: 80, color: token("success") },
		],
		overrides: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
		if (typeof min !== "number" || !Number.isFinite(min)) {
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
export function parseOverrideKey(key: string): Omit<Override, "thresholds"> | string {
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
	const rule: Omit<Override, "thresholds"> = {
		key,
		level,
		specificity: model.replaceAll("*", "").length,
		model: compileGlob(model),
	};
	if (provider !== undefined) rule.provider = provider;
	return rule;
}

/** Thresholds for a provider and model: the most specific matching override, else the global list. */
export function resolveThresholds(config: TpsConfig, provider: string, model: string): Threshold[] {
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
	return best?.thresholds ?? config.thresholds;
}

const KNOWN_KEYS = new Set(["enabled", "persist", "summaryMode", "baseColor", "animation", "thresholds", "overrides"]);

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

	for (const key of ["enabled", "persist"] as const) {
		const value = json[key];
		if (value === undefined) continue;
		if (typeof value === "boolean") config[key] = value;
		else warn(`${key}: expected true or false; using ${config[key]}`);
	}

	const { summaryMode, baseColor, animation, thresholds, overrides } = json;
	if (summaryMode === "last" || summaryMode === "session") config.summaryMode = summaryMode;
	else if (summaryMode !== undefined) warn(`summaryMode: expected "last" or "session"; using "${config.summaryMode}"`);

	if (baseColor !== undefined) {
		const parsed = parseColorSpec(baseColor);
		if (parsed) config.baseColor = parsed;
		else warn(`baseColor: ${JSON.stringify(baseColor)} is not a colour, ${COLOR_HINT}; using dim`);
	}

	if (animation !== undefined) {
		if (!isRecord(animation)) {
			warn("animation: expected an object; using defaults");
		} else {
			const { enabled, intervalMs, frames } = animation;
			if (typeof enabled === "boolean") config.animation.enabled = enabled;
			else if (enabled !== undefined) warn("animation.enabled: expected true or false; using true");
			if (typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs >= MIN_TICK_INTERVAL_MS) {
				config.animation.intervalMs = intervalMs;
			} else if (intervalMs !== undefined) {
				warn(`animation.intervalMs: expected a number >= ${MIN_TICK_INTERVAL_MS}; using ${DEFAULT_TICK_INTERVAL_MS}`);
			}
			if (
				Array.isArray(frames) &&
				frames.length > 0 &&
				frames.every((frame: unknown) => typeof frame === "string" && frame.length > 0)
			) {
				config.animation.frames = frames.filter((frame: unknown) => typeof frame === "string");
			} else if (frames !== undefined) {
				warn("animation.frames: expected a non-empty array of non-empty strings; using the default spinner");
			}
		}
	}

	if (thresholds !== undefined) {
		const parsed = parseThresholds(thresholds, "thresholds", config.baseColor, warn);
		if (parsed) config.thresholds = parsed;
	}

	if (overrides !== undefined) {
		if (!isRecord(overrides)) {
			warn("overrides: expected an object mapping match keys to threshold lists");
		} else {
			for (const [key, value] of Object.entries(overrides)) {
				const rule = parseOverrideKey(key);
				if (typeof rule === "string") {
					warn(`overrides["${key}"]: ${rule}; override ignored`);
					continue;
				}
				const parsed = parseThresholds(value, `overrides["${key}"]`, config.baseColor, warn);
				if (parsed) config.overrides.push({ ...rule, thresholds: parsed });
			}
		}
	}
	return { config, warnings };
}
