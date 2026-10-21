import { readFile } from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import { type Pi, type ProviderRequest, type StartOptions, startPi } from "../../../tools/e2e/src/index.ts";

/** pi-retry with Pi's built-in retry off and a 100 ms backoff, unless the options say otherwise. */
export function startRetry(options: Partial<StartOptions> & { config?: Record<string, unknown> } = {}): Promise<Pi> {
	const { config, ...rest } = options;
	return startPi({
		extensions: ["pi-retry"],
		tools: [],
		settings: { retry: { enabled: false } },
		...rest,
		agentFiles: { "pi-retry.json": { baseDelayMs: 100, ...config }, ...rest.agentFiles },
	});
}

/** pi-retry's notifications, in order. */
export function notices(pi: Pi): string[] {
	return pi.ui.notices.map((notice) => notice.message).filter((message) => message.startsWith("pi-retry:"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON lines of the session file as written to disk. */
export async function sessionFileEntries(pi: Pi): Promise<Record<string, unknown>[]> {
	const file = pi.session.sessionFile;
	if (file === undefined) throw new Error("the session is not file-backed");
	const text = await readFile(file, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line): unknown => JSON.parse(line))
		.filter(isRecord);
}

/** Text of each user message, as the provider received it. */
export function userTexts(messages: readonly Message[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")];
	});
}

/** The `index`th request the provider received; fails the test when there is none. */
export function request(pi: Pi, index: number): ProviderRequest {
	const found = pi.provider.requests[index];
	if (!found) throw new Error(`expected request ${index + 1}, the provider received ${pi.provider.requests.length}`);
	return found;
}
