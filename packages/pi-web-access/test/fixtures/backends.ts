/**
 * Response bodies of the backends, shaped after the live responses captured on 2026-10-23 (Sub2API alpha search
 * and Responses/Messages groups, DeepSeek, Exa), reduced to the fields the adapters read plus typical extras.
 */
import type { Recorded, Reply } from "./server.ts";
import { get } from "./session.ts";

// --- DeepSeek ---------------------------------------------------------------------------------------------------

export interface DeepSeekItem {
	url: string;
	title?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	date?: string | null;
	score?: number;
}

export function deepseekResults(items: DeepSeekItem[]): Reply {
	return {
		json: {
			results: items.map((item) => ({
				title: item.title ?? `Title of ${item.url}`,
				site_name: "Example",
				authority: 3,
				rerank_score: item.score ?? 2.1,
				date: item.date ?? null,
				url: item.url,
				summary: item.summary ?? "",
				snippet: item.snippet ?? `Snippet of ${item.url}`,
				content: item.content ?? "",
			})),
		},
	};
}

export function deepseekPage(title: string, content: string): Reply {
	return { json: { title, content } };
}

export function deepseekError(status: number, message: string): Reply {
	return {
		status,
		json: {
			error: { message: `${message} (request_id: 0000)`, type: "invalid_request_error", param: null, code: null },
		},
	};
}

// --- Exa --------------------------------------------------------------------------------------------------------

export interface ExaItem {
	url: string;
	title?: string;
	highlights?: string[];
	text?: string;
	publishedDate?: string;
}

export function exaSearch(items: ExaItem[], cost = 0.004): Reply {
	return {
		json: {
			requestId: "req-1",
			resolvedSearchType: "",
			results: items.map((item) => ({
				id: item.url,
				title: item.title ?? `Title of ${item.url}`,
				author: null,
				...item,
			})),
			searchTime: 314.6,
			costDollars: { total: cost, search: { neural: cost } },
		},
	};
}

export function exaContents(page: { url: string; title?: string; text: string; source?: "cached" | "crawled" }): Reply {
	return {
		json: {
			requestId: "req-2",
			results: [{ id: page.url, url: page.url, title: page.title ?? "Page", author: null, text: page.text }],
			statuses: [{ id: page.url, status: "success", source: page.source ?? "crawled" }],
			costDollars: { total: 0.001, contents: { text: 0.001 } },
			searchTime: 361.3,
		},
	};
}

export function exaContentsError(url: string, tag: string, httpStatusCode: number): Reply {
	return {
		json: {
			requestId: "req-3",
			results: [],
			statuses: [{ id: url, status: "error", error: { httpStatusCode, tag } }],
			costDollars: { total: 0 },
		},
	};
}

// --- Sub2API alpha search ---------------------------------------------------------------------------------------

const CITE = (id: string): string => `cite${id}`;

export function alphaSearch(items: { url: string; title?: string; snippet?: string }[]): Reply {
	return {
		json: {
			encrypted_output: "gAAAA",
			output: `${items[0]?.title ?? ""}\n${CITE("turn0search0")} [wordlim: 200] Crawled: yesterday; …`,
			results: items.map((item, index) => ({
				type: "text_result",
				domain: new URL(item.url).hostname,
				ref_id: `turn0search${index}`,
				snippet: item.snippet ?? `Snippet of ${item.url}`,
				title: item.title ?? `Title of ${item.url}`,
				url: item.url,
			})),
		},
	};
}

export const alphaEmpty: Reply = {
	json: {
		encrypted_output: "gAAAA",
		output: "Empty search results\nNo results were found for the provided queries",
		results: [],
	},
};

/** An `Internal Error ()` response, which the endpoint sends with HTTP 200 when `open` fails. */
export function alphaFailure(url: string, line: string): Reply {
	return {
		json: {
			encrypted_output: "gAAAA",
			output: `Internal Error ()\n${CITE("turn0view0")} [wordlim: 200] Source: open({"ref_id":"${url}","lineno":null}); Total lines: 1\nL0: ${line}\n`,
			results: [{ type: "text_result", ref_id: "turn0view0", snippet: "Total lines: 1", title: "Internal Error" }],
		},
	};
}

export interface AlphaPage {
	url: string;
	title: string;
	crawled: string;
	totalLines: number;
	/** The text of line n, without its `L<n>:` prefix. */
	line: (n: number) => string;
	/** The PDF page of line n, when the document is a PDF. */
	page?: (n: number) => number;
	/** Lines per window and lines repeated before `lineno`, as the live endpoint does (about 200 and a third). */
	windowLines?: number;
	backfill?: number;
}

/** Serves `open` windows of a page: from `lineno` minus the backfill, `windowLines` lines, the last window past the end. */
export function alphaOpen(page: AlphaPage): (request: Recorded) => Reply {
	const size = page.windowLines ?? 200;
	const backfill = page.backfill ?? 60;
	return (request) => {
		const lineno = openLineno(request);
		let start = lineno === undefined ? 0 : Math.max(0, lineno - backfill);
		if (start > page.totalLines - 1) start = Math.max(0, page.totalLines - size);
		const end = Math.min(page.totalLines - 1, start + size - 1);
		const lines: string[] = [];
		for (let n = start; n <= end; n++) {
			const pdfPage = page.page?.(n);
			lines.push(`L${n}${pdfPage === undefined ? "" : `@P${pdfPage}`}: ${page.line(n)}`);
		}
		const type = page.page ? "application/pdf; Number of pages: 15" : "text/html";
		const header = `${page.title} (${page.url})\n${CITE("turn0view0")} [wordlim: 200] Crawled: ${page.crawled}; Content type: ${type}; Source: open({"ref_id":"${page.url}","lineno":${lineno ?? null}}); Total lines: ${page.totalLines}`;
		return {
			json: {
				encrypted_output: "gAAAA",
				output: `${header}\n${lines.join("\n")}\n`,
				results: [
					{
						type: "text_result",
						domain: new URL(page.url).hostname,
						ref_id: "turn0view0",
						snippet: `Total lines: ${page.totalLines}`,
						title: page.title,
						url: page.url,
					},
				],
			},
		};
	};
}

/** The `lineno` of an alpha `open` request, if any. */
export function openLineno(request: Recorded): number | undefined {
	const lineno = get(request.body, "commands", "open", 0, "lineno");
	return typeof lineno === "number" ? lineno : undefined;
}

// --- Responses (Codex and Grok groups) --------------------------------------------------------------------------

export function webSearchCall(sources: string[], query = "query"): Record<string, unknown> {
	return {
		id: "ws_1",
		type: "web_search_call",
		status: "completed",
		action: { type: "search", query, queries: [query], sources: sources.map((url) => ({ type: "url", url })) },
	};
}

export function openPageCall(url: string): Record<string, unknown> {
	return { id: "ws_2", type: "web_search_call", status: "completed", action: { type: "open_page", url } };
}

export function customToolCall(name: string, input: Record<string, unknown>): Record<string, unknown> {
	return {
		call_id: "xs_call-1",
		input: JSON.stringify(input),
		name,
		type: "custom_tool_call",
		id: "ctc_1",
		status: "completed",
	};
}

export interface Citation {
	url: string;
	title: string;
	/** The cited span of the message text; defaults to the whole text. */
	start?: number;
	end?: number;
}

export function message(text: string, citations: Citation[] = []): Record<string, unknown> {
	return {
		id: "msg_1",
		type: "message",
		status: "completed",
		role: "assistant",
		content: [
			{
				type: "output_text",
				text,
				logprobs: [],
				annotations: citations.map((citation) => ({
					type: "url_citation",
					url: citation.url,
					title: citation.title,
					start_index: citation.start ?? 0,
					end_index: citation.end ?? text.length,
				})),
			},
		],
	};
}

/** A streamed Responses reply: created, one `output_item.done` per item, then `response.completed`. */
export function responsesStream(output: Record<string, unknown>[], usage: Record<string, unknown> = {}): Reply {
	return {
		sse: [
			{ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
			...output.map((item, index) => ({ type: "response.output_item.done", output_index: index, item })),
			{ type: "response.completed", response: { id: "resp_1", status: "completed", output, usage } },
		],
	};
}

// --- Messages (Claude group) ------------------------------------------------------------------------------------

export function messagesReply(content: Record<string, unknown>[], serverToolUse: Record<string, number>): Reply {
	return {
		json: {
			id: "msg_011",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content,
			stop_reason: "end_turn",
			usage: {
				input_tokens: 352,
				output_tokens: 108,
				server_tool_use: { web_search_requests: 0, web_fetch_requests: 0, ...serverToolUse },
			},
		},
	};
}

export function searchResultBlock(id: string, results: { url: string; title: string }[]): Record<string, unknown> {
	return {
		type: "web_search_tool_result",
		tool_use_id: id,
		content: results.map((result) => ({
			type: "web_search_result",
			...result,
			encrypted_content: "Esc",
			page_age: null,
		})),
		caller: { type: "direct" },
	};
}

export function serverToolUse(id: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
	return { type: "server_tool_use", id, name, input };
}

export function citedText(
	text: string,
	citations: { url: string; title: string; cited: string }[],
): Record<string, unknown> {
	return {
		type: "text",
		text,
		citations: citations.map((citation) => ({
			type: "web_search_result_location",
			cited_text: citation.cited,
			url: citation.url,
			title: citation.title,
			encrypted_index: "Eo8",
		})),
	};
}

export function fetchResultBlock(
	id: string,
	page: { url: string; title?: string; text: string; mediaType?: string; retrievedAt?: string },
): Record<string, unknown> {
	return {
		type: "web_fetch_tool_result",
		tool_use_id: id,
		content: {
			type: "web_fetch_result",
			url: page.url,
			retrieved_at: page.retrievedAt ?? "2026-10-22T22:15:31+00:00",
			content: {
				type: "document",
				source: { type: "text", media_type: page.mediaType ?? "text/plain", data: page.text },
				title: page.title ?? null,
			},
		},
		caller: { type: "direct" },
	};
}

export function toolErrorBlock(type: string, id: string, errorCode: string): Record<string, unknown> {
	return {
		type,
		tool_use_id: id,
		content: { type: `${type}_error`, error_code: errorCode },
		caller: { type: "direct" },
	};
}
