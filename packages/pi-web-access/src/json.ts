/** Narrowing helpers for JSON read from provider responses and the configuration file. */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value[key]` when `value` is an object; undefined otherwise. */
export function field(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

export function asRecord(value: unknown): JsonRecord | undefined {
	return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function records(value: unknown): JsonRecord[] {
	return asArray(value).filter(isRecord);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Parses JSON, returning undefined instead of throwing. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
