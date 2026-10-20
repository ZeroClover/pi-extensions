import { readFile } from "node:fs/promises";

export const CONFIG_FILE_NAME = "pi-retry.json";

export interface RetryPatterns {
	retryable: RegExp[];
	nonRetryable: RegExp[];
}

export interface RetryConfig {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxBackoffMs: number;
	/** The longest provider-requested wait that is honoured; 0 honours any wait. */
	maxRetryAfterMs: number;
	patterns: RetryPatterns;
}

export function defaultConfig(): RetryConfig {
	return {
		enabled: true,
		maxRetries: 10,
		baseDelayMs: 2000,
		maxBackoffMs: 60_000,
		maxRetryAfterMs: 1_800_000,
		patterns: { retryable: [], nonRetryable: [] },
	};
}

/** Integer settings with their accepted ranges; `maxBackoffMs` is additionally raised to `baseDelayMs`. */
const RANGES = {
	maxRetries: { min: 0, max: 1000 },
	baseDelayMs: { min: 100, max: 3_600_000 },
	maxBackoffMs: { min: 100, max: 86_400_000 },
	maxRetryAfterMs: { min: 0, max: 86_400_000 },
} as const;

const KNOWN_KEYS = new Set(["enabled", ...Object.keys(RANGES), "patterns"]);
const PATTERN_KEYS = ["retryable", "nonRetryable"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compilePatterns(value: unknown, path: string, warn: (message: string) => void): RegExp[] {
	if (!Array.isArray(value)) {
		warn(`${path}: expected an array of regular-expression strings; ignored`);
		return [];
	}
	const patterns: RegExp[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry === "") {
			warn(`${path}: ${JSON.stringify(entry)} is not a non-empty string; ignored`);
			continue;
		}
		try {
			patterns.push(new RegExp(entry, "i"));
		} catch (error) {
			warn(`${path}: ${JSON.stringify(entry)} is not a valid regular expression (${errorMessage(error)}); ignored`);
		}
	}
	return patterns;
}

/**
 * Parses the configuration file content. Every problem produces one warning and falls back to the default of that
 * field only. `text` is undefined when the file does not exist.
 */
export function parseConfig(text: string | undefined, source: string): { config: RetryConfig; warnings: string[] } {
	const config = defaultConfig();
	const warnings: string[] = [];
	const warn = (message: string): void => {
		warnings.push(`pi-retry: ${source}: ${message}`);
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

	const { enabled, maxBackoffMs, patterns } = json;
	if (typeof enabled === "boolean") config.enabled = enabled;
	else if (enabled !== undefined) warn(`enabled: expected true or false; using ${config.enabled}`);

	for (const [key, { min, max }] of Object.entries(RANGES) as [keyof typeof RANGES, { min: number; max: number }][]) {
		const value = json[key];
		if (value === undefined) continue;
		if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) config[key] = value;
		else warn(`${key}: expected an integer from ${min} to ${max}; using ${config[key]}`);
	}
	if (config.maxBackoffMs < config.baseDelayMs) {
		if (maxBackoffMs !== undefined) {
			warn(`maxBackoffMs: ${config.maxBackoffMs} is below baseDelayMs; using ${config.baseDelayMs}`);
		}
		config.maxBackoffMs = config.baseDelayMs;
	}

	if (isRecord(patterns)) {
		for (const key of Object.keys(patterns)) {
			if (!(PATTERN_KEYS as readonly string[]).includes(key)) warn(`patterns.${key}: unknown setting ignored`);
		}
		for (const key of PATTERN_KEYS) {
			if (patterns[key] !== undefined) config.patterns[key] = compilePatterns(patterns[key], `patterns.${key}`, warn);
		}
	} else if (patterns !== undefined) {
		warn("patterns: expected an object with retryable and nonRetryable arrays; ignored");
	}

	return { config, warnings };
}

/** Reads and parses the file at `path`; a missing file yields the defaults without a warning. */
export async function loadConfig(path: string): Promise<{ config: RetryConfig; warnings: string[] }> {
	let text: string | undefined;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			const result = parseConfig(undefined, path);
			result.warnings.push(`pi-retry: cannot read ${path}: ${errorMessage(error)}; using defaults`);
			return result;
		}
	}
	return parseConfig(text, path);
}
