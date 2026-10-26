import { messageText, postResponses, type ResponsesResult } from "../clients/responses.ts";
import { asNumber, asRecord, asString, field, type JsonRecord, records } from "../json.ts";
import { normalizeUrl, parseUrl } from "../sites.ts";
import {
	type FetchRequest,
	type ProviderEntry,
	ProviderError,
	type ProviderFetchResult,
	type ProviderSearchResult,
	type RunContext,
	type SearchHit,
	type SearchRequest,
} from "../types.ts";
import { bearerHeaders, endpoint, excludedHosts, hostsOf, nonEmpty } from "./common.ts";
import { enumOption, locationOption, type ProviderDefinition, stringOption, userLocation } from "./options.ts";

const SEARCH_INSTRUCTIONS =
	"Search the web for the user's query and answer concisely from the results, citing every source you use.";

export function openInstruction(url: string): string {
	return `Open the page ${url} with the web search tool and reply with its complete text verbatim, as markdown. Do not summarize, shorten, translate, or add commentary.`;
}

/** Posts a streaming Responses request to `<base>/responses` with the provider's credentials. */
export function responses(run: RunContext, body: Record<string, unknown>): Promise<ResponsesResult> {
	const { credentials } = run;
	return postResponses({
		url: endpoint(credentials.baseUrl, "responses"),
		body: { ...body, store: false, stream: true },
		headers: bearerHeaders(credentials.apiKey, credentials.headers),
		signal: run.signal,
		secrets: credentials.secrets,
	});
}

export function webSearchCalls(output: readonly JsonRecord[]): JsonRecord[] {
	return output.filter((item) => field(item, "type") === "web_search_call");
}

/** `url_citation` annotations of the message text, with the text before each citation as its passage. */
export function citations(output: readonly JsonRecord[]): { title: string; url: string; passage: string }[] {
	const found: { title: string; url: string; passage: string }[] = [];
	for (const part of output
		.filter((item) => field(item, "type") === "message")
		.flatMap((item) => records(field(item, "content")))) {
		const text = asString(field(part, "text")) ?? "";
		let previousEnd = 0;
		for (const annotation of records(field(part, "annotations"))) {
			const url = asString(field(annotation, "url"));
			if (field(annotation, "type") !== "url_citation" || !url) continue;
			const start = asNumber(field(annotation, "start_index")) ?? 0;
			const end = asNumber(field(annotation, "end_index")) ?? start;
			const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
			const passage = text
				.slice(Math.max(previousEnd, lineStart), start)
				.replace(/^[\s\-*•]+/, "")
				.trim();
			previousEnd = Math.max(previousEnd, end);
			found.push({ title: asString(field(annotation, "title")) ?? "", url, passage });
		}
	}
	return found;
}

/** Cited pages first, then search sources that were not cited, with their host as title. */
export function citedResults(
	output: readonly JsonRecord[],
	title: (title: string, url: string) => string,
): SearchHit[] {
	const results: SearchHit[] = citations(output).map((citation) => ({
		title: title(citation.title, citation.url),
		url: citation.url,
		snippet: citation.passage,
	}));
	const seen = new Set(results.map((result) => normalizeUrl(result.url)));
	for (const call of webSearchCalls(output)) {
		for (const source of records(field(field(call, "action"), "sources"))) {
			const url = asString(field(source, "url"));
			if (!url || seen.has(normalizeUrl(url))) continue;
			seen.add(normalizeUrl(url));
			results.push({ title: parseUrl(url)?.hostname ?? url, url, snippet: "" });
		}
	}
	return results;
}

function sameUrl(a: string, b: string): boolean {
	const strip = (url: string): string =>
		normalizeUrl(url)
			.replace(/^http:/, "https:")
			.replace(/\/$/, "");
	return strip(a) === strip(b);
}

/** Opens a page through the Responses `web_search` tool; accepted only when the model opened that URL. */
export async function openThroughWebSearch(
	run: RunContext,
	model: string | undefined,
	request: FetchRequest,
	extra: Record<string, unknown> = {},
): Promise<{ text: string; result: ResponsesResult }> {
	const result = await responses(run, {
		model,
		input: openInstruction(request.url),
		tools: [{ type: "web_search" }],
		...extra,
	});
	const opened = webSearchCalls(result.output).some((call) => {
		const action = asRecord(field(call, "action"));
		const url = asString(field(action, "url"));
		return asString(field(action, "type")) === "open_page" && url !== undefined && sameUrl(url, request.url);
	});
	if (!opened) throw new ProviderError("the model did not open the page");
	return { text: messageText(result.output), result };
}

/** Responses `filters` from the hostnames of the domain filters; `excludeKey` differs between Codex and Grok. */
export function domainFilters(
	request: SearchRequest,
	excludeKey: string,
	options: { exclusive?: boolean } = {},
): Record<string, string[]> | undefined {
	const allowed = nonEmpty(hostsOf(request.domains));
	const blocked = nonEmpty(excludedHosts(request.excludeDomains));
	if (!allowed && !blocked) return undefined;
	const keepBlocked = blocked !== undefined && !(options.exclusive && request.domains.length > 0);
	if (!allowed && !keepBlocked) return undefined;
	return { ...(allowed ? { allowed_domains: allowed } : {}), ...(keepBlocked ? { [excludeKey]: blocked } : {}) };
}

function codexSearchTool(entry: ProviderEntry, request: SearchRequest): Record<string, unknown> {
	return {
		type: "web_search",
		filters: domainFilters(request, "blocked_domains"),
		user_location: userLocation(entry),
		search_context_size: stringOption(entry, "searchContextSize"),
	};
}

export const sub2apiCodex: ProviderDefinition = {
	requires: ["provider", "model"],
	defaults: { timeoutMs: 60_000 },
	options: { userLocation: locationOption, searchContextSize: enumOption(["low", "medium", "high"]) },
	create: (entry) => ({
		search: { domains: "hard", maxCount: 0, recency: false, content: false },
		fetchExtraction: "model",
		async runSearch(request: SearchRequest, run: RunContext): Promise<ProviderSearchResult> {
			const result = await responses(run, {
				model: entry.model,
				instructions: SEARCH_INSTRUCTIONS,
				input: request.query,
				tools: [codexSearchTool(entry, request)],
				tool_choice: "required",
				include: ["web_search_call.action.sources"],
			});
			if (webSearchCalls(result.output).length === 0) throw new ProviderError("no web search performed");
			const answer = messageText(result.output);
			return {
				results: citedResults(result.output, (title, url) => title || (parseUrl(url)?.hostname ?? url)),
				...(answer ? { answer } : {}),
				warnings: [],
			};
		},
		async runFetch(request: FetchRequest, run: RunContext): Promise<ProviderFetchResult> {
			const { text } = await openThroughWebSearch(run, entry.model, request, { tool_choice: "required" });
			return { content: text, complete: true, extraction: "model", warnings: [] };
		},
	}),
};
