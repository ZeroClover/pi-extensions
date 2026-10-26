import { asRecord, asString, errorMessage, field, parseJson } from "../json.ts";
import { ProviderError } from "../types.ts";

export interface HttpRequest {
	url: string;
	body: unknown;
	headers: Record<string, string>;
	signal: AbortSignal;
	/** Credential values replaced with `<redacted>` in every error this client raises. */
	secrets: readonly string[];
}

export interface HttpResult {
	status: number;
	headers: Headers;
	text: string;
	json: unknown;
}

/** Replaces every secret in `text` with `<redacted>`. */
export function redact(text: string, secrets: readonly string[]): string {
	let result = text;
	for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join("<redacted>");
	return result;
}

/** The message a JSON error body carries: `error.message`, `error` as text, or `message`. */
export function bodyMessage(json: unknown, text: string): string {
	const body = asRecord(json);
	const error = field(body, "error");
	const message =
		asString(field(error, "message")) ?? asString(error) ?? asString(field(body, "message")) ?? text.trim();
	return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/** Sends the request and returns the raw response, or throws a ProviderError for transport failures. */
export async function send(request: HttpRequest): Promise<Response> {
	try {
		return await fetch(request.url, {
			method: "POST",
			headers: { "content-type": "application/json", ...request.headers },
			body: JSON.stringify(request.body),
			signal: request.signal,
		});
	} catch (error) {
		if (request.signal.aborted) throw error;
		const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
		throw new ProviderError(redact(`network error: ${errorMessage(error)}${cause}`, request.secrets));
	}
}

/** Posts JSON and reads the whole response; non-2xx statuses are returned, not thrown. */
export async function postJson(request: HttpRequest): Promise<HttpResult> {
	const response = await send(request);
	const text = await response.text();
	return { status: response.status, headers: response.headers, text, json: parseJson(text) };
}

/**
 * The ProviderError for a non-success status: `<status> <hint>: <message>`, with the hint per status from `hints`
 * (or the default for 401, 402, 429 and 5xx).
 */
export function statusError(
	result: HttpResult,
	secrets: readonly string[],
	hints: Record<number, string> = {},
): ProviderError {
	const defaults: Record<number, string> = {
		401: "credentials rejected",
		402: "payment required",
		403: "forbidden",
		429: "rate limited",
	};
	const hint = hints[result.status] ?? defaults[result.status] ?? (result.status >= 500 ? "server error" : undefined);
	const message = bodyMessage(result.json, result.text);
	const reason =
		hint === undefined
			? `${result.status}${message ? ` ${message}` : ""}`
			: `${result.status} ${hint}${message ? `: ${message}` : ""}`;
	return new ProviderError(redact(reason, secrets));
}
