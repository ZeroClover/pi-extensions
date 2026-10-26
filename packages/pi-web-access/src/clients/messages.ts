import { asRecord, field, type JsonRecord, records } from "../json.ts";
import { mergeHeaders } from "../providers/common.ts";
import { ProviderError, type RunContext } from "../types.ts";
import { postJson, statusError } from "./http.ts";

/** A Messages API response: its content blocks and usage. */
export interface MessagesResult {
	content: JsonRecord[];
	usage: JsonRecord | undefined;
}

/** `<root>/v1/messages`, where the root is the base URL without a trailing `/v1`. */
export function messagesUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/messages`;
}

/** Posts a non-streaming Messages request with the provider's credentials. */
export async function postMessages(run: RunContext, body: Record<string, unknown>): Promise<MessagesResult> {
	const { credentials } = run;
	const key = credentials.apiKey;
	const result = await postJson({
		url: messagesUrl(credentials.baseUrl),
		body,
		headers: mergeHeaders(
			{ "anthropic-version": "2023-06-01" },
			key ? { "x-api-key": key, authorization: `Bearer ${key}` } : {},
			credentials.headers,
		),
		signal: run.signal,
		secrets: credentials.secrets,
	});
	if (result.status < 200 || result.status >= 300) throw statusError(result, credentials.secrets);
	const json = asRecord(result.json);
	if (!json) throw new ProviderError("invalid JSON response");
	return { content: records(field(json, "content")), usage: asRecord(field(json, "usage")) };
}
