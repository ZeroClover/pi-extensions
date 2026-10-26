import { asNumber, asString, field, isRecord } from "../json.ts";
import type { ProviderEntry, WebProvider } from "../types.ts";

/** How the configuration parser validates one type-specific option. */
export interface OptionSpec {
	/** What a valid value looks like, for the warning. */
	expected: string;
	valid(value: unknown): boolean;
}

/** What the configuration file and the routing engine need to know about a provider type. */
export interface ProviderDefinition {
	/** Entry fields the type cannot work without. */
	requires: readonly ("provider" | "model")[];
	defaults: { provider?: string; apiKey?: string; baseUrl?: string; timeoutMs: number };
	options: Record<string, OptionSpec>;
	create(entry: ProviderEntry): WebProvider;
}

export function enumOption(values: readonly string[]): OptionSpec {
	return {
		expected: `one of ${values.join(", ")}`,
		valid: (value) => typeof value === "string" && values.includes(value),
	};
}

export function integerOption(min: number, max: number): OptionSpec {
	return {
		expected: `an integer from ${min} to ${max}`,
		valid: (value) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max,
	};
}

export const booleanOption: OptionSpec = { expected: "true or false", valid: (value) => typeof value === "boolean" };

const LOCATION_KEYS = ["country", "region", "city", "timezone"];

/** `{ country?, region?, city?, timezone? }`, the approximate location web search tools accept. */
export const locationOption: OptionSpec = {
	expected: "an object with country, region, city and timezone strings",
	valid: (value) =>
		isRecord(value) &&
		Object.entries(value).every(([key, field]) => LOCATION_KEYS.includes(key) && typeof field === "string"),
};

/** The `userLocation` option as the approximate-location object OpenAI and Anthropic tools take. */
export function userLocation(entry: ProviderEntry): Record<string, string> | undefined {
	const value = field(entry.options, "userLocation");
	if (!isRecord(value)) return undefined;
	const location: Record<string, string> = { type: "approximate" };
	for (const key of LOCATION_KEYS) {
		const field = asString(value[key]);
		if (field !== undefined) location[key] = field;
	}
	return location;
}

export function stringOption(entry: ProviderEntry, key: string): string | undefined {
	return asString(entry.options[key]);
}

export function numberOption(entry: ProviderEntry, key: string): number | undefined {
	return asNumber(entry.options[key]);
}
