import { readFile } from "node:fs/promises";
import { BUILTIN_ADAPTERS, type ToolAdapter } from "./adapters.ts";

export const CONFIG_FILE_NAME = "pi-rtk.json";

const ADAPTER_KEYS = ["commandField", "shellField", "ttyField", "cwdField"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseAdapter(
	value: Record<string, unknown>,
	path: string,
	warn: (message: string) => void,
): ToolAdapter | undefined {
	for (const key of Object.keys(value)) {
		if (!(ADAPTER_KEYS as readonly string[]).includes(key)) warn(`${path}.${key}: unknown setting ignored`);
	}
	const fields: Partial<Record<(typeof ADAPTER_KEYS)[number], string>> = {};
	for (const key of ADAPTER_KEYS) {
		const field = value[key];
		if (field === undefined) continue;
		if (typeof field === "string" && field !== "") fields[key] = field;
		else warn(`${path}.${key}: expected a non-empty input field name; ignored`);
	}
	const { commandField, ...rest } = fields;
	if (commandField === undefined) {
		warn(`${path}: commandField is required; tool ignored`);
		return undefined;
	}
	return { commandField, ...rest };
}

/**
 * Parses the configuration file content into the adapter table: the built-in adapters, with each `tools` entry
 * adding a tool, replacing a built-in adapter, or (`false`) removing one. Every problem produces one warning and
 * leaves the affected entry at its built-in state. `text` is undefined when the file does not exist.
 */
export function parseConfig(
	text: string | undefined,
	source: string,
): { adapters: Map<string, ToolAdapter>; warnings: string[] } {
	const adapters = new Map(Object.entries(BUILTIN_ADAPTERS));
	const warnings: string[] = [];
	const warn = (message: string): void => {
		warnings.push(`pi-rtk: ${source}: ${message}`);
	};
	if (text === undefined) return { adapters, warnings };
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		warn(`invalid JSON (${errorMessage(error)}); using the built-in tools`);
		return { adapters, warnings };
	}
	if (!isRecord(json)) {
		warn("expected a JSON object; using the built-in tools");
		return { adapters, warnings };
	}
	for (const key of Object.keys(json)) if (key !== "tools") warn(`${key}: unknown setting ignored`);

	const { tools } = json;
	if (tools === undefined) return { adapters, warnings };
	if (!isRecord(tools)) {
		warn("tools: expected an object mapping tool names to adapters or false; using the built-in tools");
		return { adapters, warnings };
	}
	for (const [name, value] of Object.entries(tools)) {
		if (value === false) {
			adapters.delete(name);
		} else if (isRecord(value)) {
			const adapter = parseAdapter(value, `tools.${name}`, warn);
			if (adapter) adapters.set(name, adapter);
		} else {
			warn(`tools.${name}: expected an adapter object or false; ignored`);
		}
	}
	return { adapters, warnings };
}

/** Reads and parses the file at `path`; a missing file yields the built-in tools without a warning. */
export async function loadConfig(path: string): Promise<{ adapters: Map<string, ToolAdapter>; warnings: string[] }> {
	let text: string | undefined;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			const result = parseConfig(undefined, path);
			result.warnings.push(`pi-rtk: cannot read ${path}: ${errorMessage(error)}; using the built-in tools`);
			return result;
		}
	}
	return parseConfig(text, path);
}
