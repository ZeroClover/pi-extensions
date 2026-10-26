import { readFile } from "node:fs/promises";
import { asArray, asString, errorMessage, field, isRecord } from "./json.ts";
import type { ProviderDefinition } from "./providers/options.ts";
import { normalizeSite } from "./sites.ts";
import { PROVIDER_TYPES, type ProviderEntry, type ProviderType } from "./types.ts";

export const CONFIG_FILE_NAME = "pi-web-access.json";

export interface SiteRule {
	name: string;
	sites: string[];
	search?: string[];
	fetch?: string[];
}

export interface WebAccessConfig {
	/** Providers in declaration order. */
	providers: ProviderEntry[];
	search: string[];
	fetch: string[];
	rules: SiteRule[];
}

export interface LoadedConfig {
	config: WebAccessConfig;
	warnings: string[];
	/** Whether the file exists. */
	found: boolean;
}

const TOP_KEYS = new Set(["providers", "search", "fetch", "rules"]);
const COMMON_KEYS = ["type", "provider", "model", "apiKey", "baseUrl", "timeoutMs"];
const RULE_KEYS = new Set(["name", "sites", "search", "fetch"]);
const TIMEOUT = { min: 1000, max: 600_000 };

export function emptyConfig(): WebAccessConfig {
	return { providers: [], search: [], fetch: [], rules: [] };
}

function isProviderType(value: unknown): value is ProviderType {
	return typeof value === "string" && (PROVIDER_TYPES as readonly string[]).includes(value);
}

function parseProvider(
	name: string,
	value: unknown,
	definitions: Record<ProviderType, ProviderDefinition>,
	warn: (message: string) => void,
): ProviderEntry | undefined {
	const where = `providers.${name}`;
	if (/\s/.test(name) || name === "") {
		warn(`${where}: provider names cannot be empty or contain whitespace; provider ignored`);
		return undefined;
	}
	if (!isRecord(value)) {
		warn(`${where}: expected an object; provider ignored`);
		return undefined;
	}
	const { type } = value;
	if (!isProviderType(type)) {
		warn(
			`${where}: unknown type ${JSON.stringify(type)}; expected one of ${PROVIDER_TYPES.join(", ")}; provider ignored`,
		);
		return undefined;
	}
	const definition = definitions[type];
	const entry: ProviderEntry = { name, type, timeoutMs: definition.defaults.timeoutMs, options: {} };

	for (const key of Object.keys(value)) {
		if (!COMMON_KEYS.includes(key) && !(key in definition.options)) {
			warn(`${where}: ${key} is unknown for type ${type}; ignored`);
		}
	}
	for (const key of ["provider", "model", "apiKey", "baseUrl"] as const) {
		const field = value[key];
		if (field === undefined) continue;
		if (typeof field !== "string" || field.trim() === "") {
			warn(`${where}: ${key} must be a non-empty string; provider ignored`);
			return undefined;
		}
		entry[key] = field.trim();
	}
	if (entry.baseUrl !== undefined) {
		if (!/^https?:\/\//.test(entry.baseUrl)) {
			warn(`${where}: baseUrl must be an http or https URL; provider ignored`);
			return undefined;
		}
		entry.baseUrl = entry.baseUrl.replace(/\/+$/, "");
	}
	const { timeoutMs } = value;
	if (timeoutMs !== undefined) {
		if (
			typeof timeoutMs === "number" &&
			Number.isInteger(timeoutMs) &&
			timeoutMs >= TIMEOUT.min &&
			timeoutMs <= TIMEOUT.max
		) {
			entry.timeoutMs = timeoutMs;
		} else {
			warn(`${where}: timeoutMs must be an integer from ${TIMEOUT.min} to ${TIMEOUT.max}; using ${entry.timeoutMs}`);
		}
	}
	for (const [key, spec] of Object.entries(definition.options)) {
		const option = value[key];
		if (option === undefined) continue;
		if (!spec.valid(option)) {
			warn(`${where}: ${key} must be ${spec.expected}; provider ignored`);
			return undefined;
		}
		entry.options[key] = option;
	}
	if (entry.provider === undefined && definition.defaults.provider !== undefined && entry.apiKey === undefined) {
		entry.provider = definition.defaults.provider;
	}
	if (entry.apiKey === undefined && entry.provider === undefined && definition.defaults.apiKey !== undefined) {
		entry.apiKey = definition.defaults.apiKey;
	}
	for (const field of definition.requires) {
		if (entry[field] === undefined) {
			warn(`${where}: a ${type} provider needs ${field}; provider ignored`);
			return undefined;
		}
	}
	return entry;
}

/** Keeps the names that refer to declared providers, warning once per unknown name. */
function knownNames(
	value: unknown,
	where: string,
	declared: ReadonlySet<string>,
	warn: (message: string) => void,
): string[] | undefined {
	if (!Array.isArray(value)) {
		warn(`${where}: expected an array of provider names; ignored`);
		return undefined;
	}
	const names: string[] = [];
	for (const name of value) {
		if (typeof name !== "string" || !declared.has(name)) {
			warn(`${where}: ${JSON.stringify(name)} is not a configured provider; removed`);
		} else if (!names.includes(name)) {
			names.push(name);
		}
	}
	return names;
}

function parseRule(
	value: unknown,
	index: number,
	declared: ReadonlySet<string>,
	warn: (message: string) => void,
): SiteRule | undefined {
	if (!isRecord(value)) {
		warn(`rules[${index}]: expected an object; rule ignored`);
		return undefined;
	}
	const name = asString(field(value, "name"))?.trim();
	if (!name) {
		warn(`rules[${index}]: name must be a non-empty string; rule ignored`);
		return undefined;
	}
	const where = `rules.${name}`;
	for (const key of Object.keys(value)) if (!RULE_KEYS.has(key)) warn(`${where}: ${key} is unknown; ignored`);
	const sites = asArray(field(value, "sites")).flatMap((site) => {
		const normalized = typeof site === "string" ? normalizeSite(site) : undefined;
		if (normalized === undefined) warn(`${where}.sites: ${JSON.stringify(site)} is not a site pattern; ignored`);
		return normalized === undefined ? [] : [normalized];
	});
	if (sites.length === 0) {
		warn(`${where}: sites must be a non-empty array of site patterns; rule ignored`);
		return undefined;
	}
	const rule: SiteRule = { name, sites };
	for (const capability of ["search", "fetch"] as const) {
		if (value[capability] === undefined) continue;
		const names = knownNames(value[capability], `${where}.${capability}`, declared, warn);
		if (names !== undefined && names.length > 0) rule[capability] = names;
	}
	if (rule.search === undefined && rule.fetch === undefined) {
		warn(`${where}: no configured provider left for search or fetch; rule ignored`);
		return undefined;
	}
	return rule;
}

/** Parses the file content; every problem yields one warning and drops or defaults only what it concerns. */
export function parseConfig(
	text: string,
	source: string,
	definitions: Record<ProviderType, ProviderDefinition>,
): { config: WebAccessConfig; warnings: string[] } {
	const config = emptyConfig();
	const warnings: string[] = [];
	const warn = (message: string): void => {
		warnings.push(`pi-web-access: ${source}: ${message}`);
	};
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		warn(`invalid JSON (${errorMessage(error)}); no provider is configured`);
		return { config, warnings };
	}
	if (!isRecord(json)) {
		warn("expected a JSON object; no provider is configured");
		return { config, warnings };
	}
	for (const key of Object.keys(json)) if (!TOP_KEYS.has(key)) warn(`${key}: unknown setting; ignored`);

	const { providers } = json;
	if (isRecord(providers)) {
		for (const [name, value] of Object.entries(providers)) {
			const entry = parseProvider(name, value, definitions, warn);
			if (entry) config.providers.push(entry);
		}
	} else if (providers !== undefined) {
		warn("providers: expected an object of provider name to provider entry; ignored");
	}
	const declared = new Set(config.providers.map((entry) => entry.name));
	for (const capability of ["search", "fetch"] as const) {
		const names = json[capability] === undefined ? undefined : knownNames(json[capability], capability, declared, warn);
		config[capability] = names ?? [...declared];
	}
	const { rules } = json;
	if (Array.isArray(rules)) {
		rules.forEach((value, index) => {
			const rule = parseRule(value, index, declared, warn);
			if (rule) config.rules.push(rule);
		});
	} else if (rules !== undefined) {
		warn("rules: expected an array; ignored");
	}
	return { config, warnings };
}

/** Reads and parses the configuration file; a missing file is an empty configuration with `found: false`. */
export async function loadConfig(
	path: string,
	definitions: Record<ProviderType, ProviderDefinition>,
): Promise<LoadedConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { config: emptyConfig(), warnings: [], found: false };
		}
		return {
			config: emptyConfig(),
			warnings: [`pi-web-access: cannot read ${path}: ${errorMessage(error)}`],
			found: true,
		};
	}
	return { ...parseConfig(text, path, definitions), found: true };
}
