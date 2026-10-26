import { postMessages } from "../clients/messages.ts";
import { asNumber, asRecord, asString, field, type JsonRecord, records } from "../json.ts";
import { normalizeUrl, parseUrl } from "../sites.ts";
import {
	type FetchRequest,
	ProviderError,
	type ProviderFetchResult,
	type ProviderSearchResult,
	ProviderSkip,
	type RunContext,
	type SearchHit,
	type SearchRequest,
} from "../types.ts";
import { excludedHosts, hostsOf, nonEmpty } from "./common.ts";
import { integerOption, locationOption, numberOption, type ProviderDefinition, userLocation } from "./options.ts";

/** Ids of server tool calls the Sub2API gateway answered with its own search emulation. */
const EMULATED_ID = /^srvtoolu_ws_/;

function serverToolRequests(usage: JsonRecord | undefined, key: string): number | undefined {
	return asNumber(asRecord(field(usage, "server_tool_use"))?.[key]);
}

function toolError(content: unknown): string | undefined {
	const record = asRecord(content);
	if (!record || !asString(field(record, "type"))?.endsWith("_error")) return undefined;
	return asString(field(record, "error_code")) ?? "tool error";
}

function isPdfPath(url: string): boolean {
	return parseUrl(url)?.pathname.toLowerCase().endsWith(".pdf") === true;
}

export const sub2apiClaude: ProviderDefinition = {
	requires: ["provider", "model"],
	defaults: { timeoutMs: 60_000 },
	options: { maxUses: integerOption(1, 10), userLocation: locationOption },
	create: (entry) => ({
		search: { domains: "hard", maxCount: 0, recency: false, content: false },
		fetchExtraction: "verbatim",
		async runSearch(request: SearchRequest, run: RunContext): Promise<ProviderSearchResult> {
			const warnings: string[] = [];
			const allowed = nonEmpty(hostsOf(request.domains));
			const blocked = nonEmpty(excludedHosts(request.excludeDomains));
			// The tool rejects both lists together, and path exclusions it cannot take at all; with domains, every
			// exclusion is left to the search tool's result filter.
			const restricted = request.domains.length > 0;
			if (restricted && request.excludeDomains.length > 0) {
				warnings.push(
					`${entry.name}: excludeDomains were applied to the results, since the search tool cannot take both domain lists`,
				);
			}
			const tool = {
				type: "web_search_20250305",
				name: "web_search",
				max_uses: numberOption(entry, "maxUses") ?? 3,
				allowed_domains: allowed,
				blocked_domains: restricted ? undefined : blocked,
				user_location: userLocation(entry),
			};
			const response = await postMessages(run, {
				model: entry.model,
				max_tokens: 2048,
				messages: [
					{ role: "user", content: `Search the web for: ${request.query}\nAnswer concisely from the results.` },
				],
				tools: [tool],
			});

			const cited = new Map<string, string>();
			const answer: string[] = [];
			const results: SearchHit[] = [];
			let emulated = false;
			for (const block of response.content) {
				const type = asString(field(block, "type"));
				const id = asString(field(block, "id")) ?? asString(field(block, "tool_use_id")) ?? "";
				if (EMULATED_ID.test(id)) emulated = true;
				if (type === "text") {
					answer.push(asString(field(block, "text")) ?? "");
					for (const citation of records(field(block, "citations"))) {
						const url = asString(field(citation, "url"));
						const text = asString(field(citation, "cited_text"));
						if (url && text && !cited.has(normalizeUrl(url))) cited.set(normalizeUrl(url), text);
					}
				} else if (type === "web_search_tool_result") {
					const error = toolError(field(block, "content"));
					if (error) throw new ProviderError(`search tool error: ${error}`);
					for (const item of records(field(block, "content"))) {
						const url = asString(field(item, "url"));
						if (url) results.push({ title: asString(field(item, "title")) || url, url, snippet: "" });
					}
				}
			}
			if (serverToolRequests(response.usage, "web_search_requests") === 0) {
				throw new ProviderError("no web search performed");
			}
			for (const result of results) result.snippet = cited.get(normalizeUrl(result.url)) ?? "";
			if (emulated)
				warnings.push(`${entry.name}: the gateway emulated the search; provider-side filters were not applied`);
			const text = answer.join("").trim();
			return { results, ...(text ? { answer: text } : {}), warnings };
		},
		async runFetch(request: FetchRequest, run: RunContext): Promise<ProviderFetchResult> {
			// The fetch tool returns a PDF as the whole file in base64, which costs tens of thousands of tokens.
			if (isPdfPath(request.url)) throw new ProviderSkip("unsupported: pdf");
			const host = parseUrl(request.url)?.hostname;
			const wanted = request.offset + request.maxChars;
			const response = await postMessages(run, {
				model: entry.model,
				max_tokens: 256,
				messages: [{ role: "user", content: `Fetch ${request.url} with the web_fetch tool, then reply only "done".` }],
				tools: [
					{
						type: "web_fetch_20260309",
						name: "web_fetch",
						max_uses: 1,
						allowed_callers: ["direct"],
						use_cache: false,
						...(host ? { allowed_domains: [host] } : {}),
						max_content_tokens: 3 * wanted,
					},
				],
			});
			const block = response.content.find((item) => field(item, "type") === "web_fetch_tool_result");
			const error = toolError(field(block, "content"));
			if (error) throw new ProviderError(`fetch tool error: ${error}`);
			if (serverToolRequests(response.usage, "web_fetch_requests") === 0 || !block) {
				throw new ProviderError("no web fetch performed");
			}
			const result = asRecord(field(block, "content"));
			const documentBlock = asRecord(field(result, "content"));
			const source = asRecord(field(documentBlock, "source"));
			if (asString(field(source, "media_type")) === "application/pdf" || asString(field(source, "type")) === "base64") {
				throw new ProviderError("unsupported: pdf");
			}
			const content = asString(field(source, "data")) ?? "";
			const title = asString(field(documentBlock, "title"));
			const finalUrl = asString(field(result, "url"));
			const crawledAt = asString(field(result, "retrieved_at"));
			return {
				content,
				// The tool cuts the document at max_content_tokens without saying so. A token is at least one byte and a
				// UTF-16 code unit at most three, so a cut document has at least a third of the budget in characters:
				// a text shorter than that cannot have been cut.
				complete: content.length < wanted,
				extraction: "verbatim",
				...(title ? { title } : {}),
				...(finalUrl ? { finalUrl } : {}),
				...(crawledAt ? { crawledAt } : {}),
				warnings: [],
			};
		},
	}),
};
