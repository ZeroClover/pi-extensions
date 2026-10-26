import { asRecord, asString, field, type JsonRecord, parseJson, records } from "../json.ts";
import { ProviderError } from "../types.ts";
import { type HttpRequest, redact, send, statusError } from "./http.ts";

/** A completed Responses API response: its output items and usage. */
export interface ResponsesResult {
	output: JsonRecord[];
	usage: JsonRecord | undefined;
}

function eventMessage(event: JsonRecord): string {
	const response = asRecord(field(event, "response"));
	const error = asRecord(field(response, "error")) ?? asRecord(field(event, "error"));
	return (
		asString(field(error, "message")) ??
		asString(field(event, "message")) ??
		asString(field(error, "code")) ??
		"unknown error"
	);
}

function completed(response: JsonRecord, items: JsonRecord[]): ResponsesResult {
	const status = asString(field(response, "status"));
	if (status !== undefined && status !== "completed") {
		const reason = asString(field(field(response, "incomplete_details"), "reason"));
		throw new ProviderError(`response ${status}${reason ? `: ${reason}` : ""}`);
	}
	const output = records(field(response, "output"));
	return { output: output.length > 0 ? output : items, usage: asRecord(field(response, "usage")) };
}

/**
 * Posts a streaming Responses request and reads it to the end. An HTTP status of 400 or more, an `error` or
 * `response.failed` event, a stream without `response.completed`, or a status other than `completed` fails.
 * Output items come from `response.completed`, or from `response.output_item.done` events when it carries none.
 */
export async function postResponses(request: HttpRequest): Promise<ResponsesResult> {
	const response = await send(request);
	const secrets = request.secrets;
	if (response.status >= 400 || !response.body) {
		const text = await response.text();
		throw statusError({ status: response.status, headers: response.headers, text, json: parseJson(text) }, secrets);
	}
	if (response.headers.get("content-type")?.includes("application/json")) {
		const json = asRecord(parseJson(await response.text()));
		if (!json) throw new ProviderError("invalid JSON response");
		return completed(json, []);
	}
	const items: JsonRecord[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	const handle = (block: string): ResponsesResult | undefined => {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data === "" || data === "[DONE]") return undefined;
		const event = asRecord(parseJson(data));
		if (!event) return undefined;
		const type = asString(field(event, "type"));
		const item = asRecord(field(event, "item"));
		if (type === "response.output_item.done" && item) items.push(item);
		if (type === "error" || type === "response.failed") {
			throw new ProviderError(redact(`${type}: ${eventMessage(event)}`, secrets));
		}
		if (type === "response.incomplete" || type === "response.completed") {
			return completed(asRecord(field(event, "response")) ?? {}, items);
		}
		return undefined;
	};
	for await (const chunk of response.body) {
		// Normalise the whole buffer: a CRLF pair can be split between two network chunks.
		buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
		let end = buffer.indexOf("\n\n");
		while (end >= 0) {
			const result = handle(buffer.slice(0, end));
			if (result) return result;
			buffer = buffer.slice(end + 2);
			end = buffer.indexOf("\n\n");
		}
	}
	const result = handle(buffer);
	if (result) return result;
	throw new ProviderError("the stream ended before response.completed");
}

/** The text of every message output item, concatenated. */
export function messageText(output: readonly JsonRecord[]): string {
	return output
		.filter((item) => field(item, "type") === "message")
		.flatMap((item) => records(field(item, "content")))
		.map((part) => asString(field(part, "text")) ?? "")
		.join("");
}
