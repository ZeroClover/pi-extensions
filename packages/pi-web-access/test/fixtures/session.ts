import type { JsonObject } from "@earendil-works/pi-ai";
import { type Pi, reply, type StartOptions, startPi, text, toolCall } from "../../../../tools/e2e/src/index.ts";

export const PACKAGE = "pi-web-access";
/** The codemode loader, as a path `startPi` resolves under `packages/`. */
export const CODEMODE = "pi-web-access/test/fixtures/codemode.ts";
/** The codemode loader with no inline budget, so that no tool is listed in its description. */
export const CODEMODE_UNLISTED = "pi-web-access/test/fixtures/codemode-unlisted.ts";

export interface WebAccessOptions extends Partial<StartOptions> {
	/** Written as `pi-web-access.json`; no file when omitted. */
	config?: unknown;
	/** Providers written into `models.json`. */
	models?: Record<string, unknown>;
	/** Written as `auth.json`. */
	auth?: unknown;
}

/** Starts Pi with this package, the two tools active, and the given agent files. */
export function startWebAccess(options: WebAccessOptions = {}): Promise<Pi> {
	const { config, models, auth, agentFiles, ...rest } = options;
	return startPi({
		extensions: [PACKAGE],
		tools: ["web_search", "web_fetch"],
		...rest,
		agentFiles: {
			...(config === undefined ? {} : { "pi-web-access.json": config }),
			...(models === undefined ? {} : { "models.json": { providers: models } }),
			...(auth === undefined ? {} : { "auth.json": auth }),
			...agentFiles,
		},
	});
}

/** A `models.json` provider served by a fixture: one model, a literal key, optional model-level headers. */
export function piProvider(
	baseUrl: string,
	model: string,
	options: { key?: string; headers?: Record<string, string> } = {},
) {
	return {
		baseUrl,
		apiKey: options.key ?? "pi-key-0001",
		api: "openai-responses",
		models: [{ id: model, ...(options.headers ? { headers: options.headers } : {}) }],
	};
}

export interface ToolOutcome {
	text: string;
	structured: unknown;
	isError: boolean;
	/** Progress messages sent while the tool ran. */
	updates: string[];
}

function textOf(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content))
		return "";
	return result.content
		.map((block: unknown) =>
			typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
				? block.text
				: "",
		)
		.join("");
}

/** Has the scripted model call `tool` once with `args` and returns what the tool produced. */
export async function call(pi: Pi, tool: string, args: JsonObject): Promise<ToolOutcome> {
	let outcome: ToolOutcome | undefined;
	const updates: string[] = [];
	const unsubscribe = pi.session.subscribe((event) => {
		if (event.type === "tool_execution_update") updates.push(textOf(event.partialResult));
		if (event.type === "tool_execution_end") {
			const result: unknown = event.result;
			const structured =
				typeof result === "object" && result !== null && "structuredContent" in result
					? result.structuredContent
					: undefined;
			outcome = { text: textOf(result), structured, isError: event.isError, updates };
		}
	});
	try {
		pi.provider.respond(reply(toolCall(tool, args)), reply(text("done")));
		await pi.prompt(`call ${tool}`);
	} finally {
		unsubscribe();
	}
	if (!outcome) throw new Error(`${tool} did not run`);
	return outcome;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a nested value of an unknown result: `get(value, "results", 0, "url")`. */
export function get(value: unknown, ...path: (string | number)[]): unknown {
	let current = value;
	for (const key of path) {
		if (Array.isArray(current)) current = current[Number(key)];
		else if (isRecord(current)) current = current[String(key)];
		else return undefined;
	}
	return current;
}

/** The notices whose message starts with `pi-web-access:`, by level. */
export function notices(pi: Pi, level?: "info" | "warning" | "error"): string[] {
	return pi.ui.notices
		.filter((notice) => notice.message.startsWith("pi-web-access:") && (level === undefined || notice.level === level))
		.map((notice) => notice.message);
}
