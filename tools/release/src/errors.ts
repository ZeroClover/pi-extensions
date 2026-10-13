/** A release protocol, validation, or evidence failure. Publication stops; nothing is guessed. */
export class ReleaseError extends Error {
	override readonly name = "ReleaseError";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One property of untyped JSON or YAML data; undefined when the value is not an object. */
export function field(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
