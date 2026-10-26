import { messageText, type ResponsesResult } from "../clients/responses.ts";
import { asNumber, field, type JsonRecord } from "../json.ts";
import { parseUrl, siteHost, sitePath } from "../sites.ts";
import {
	type FetchRequest,
	type ProviderEntry,
	ProviderError,
	type ProviderFetchResult,
	type ProviderSearchResult,
	type RunContext,
	type SearchRequest,
} from "../types.ts";
import { nonEmpty, recencyDate } from "./common.ts";
import { booleanOption, type ProviderDefinition } from "./options.ts";
import {
	citations,
	citedResults,
	domainFilters,
	openThroughWebSearch,
	responses,
	webSearchCalls,
} from "./sub2api-codex.ts";

const SEARCH_INSTRUCTIONS = "Answer concisely from the search results and cite every source you use.";

/** Grok's private inline citation markers, in the plain-text and the XML form, and stray control tokens. */
const MARKERS = [
	/\s*(?:show\s+)?render_inline_citation(?:\s+with\s+citation_id\s+is\s+\d+)?/g,
	/<grok:render[\s\S]*?<\/grok:render>/g,
	// An end-of-sequence token the gateway sometimes leaves in the text.
	/<\|eos\|>/g,
];

export function stripMarkers(text: string): string {
	return MARKERS.reduce((result, marker) => result.replace(marker, ""), text);
}

function isXHost(host: string): boolean {
	return ["x.com", "twitter.com"].some((root) => host === root || host.endsWith(`.${root}`));
}

/** The account handle of an X site entry (`x.com/golang` → `golang`), or undefined for a bare host. */
function handleOf(site: string): string | undefined {
	const handle = sitePath(site).split("/")[1];
	return handle && !["i", "search", "home", "hashtag"].includes(handle) ? handle : undefined;
}

/** The post id of an X post URL (`x.com/<user>/status/<id>`, also `twitter.com` and `x.com/i/status/<id>`). */
function postId(url: string): string | undefined {
	const parsed = parseUrl(url);
	if (!parsed || !isXHost(parsed.hostname.toLowerCase())) return undefined;
	return parsed.pathname.match(/^\/(?:[^/]+|i\/web)\/status\/(\d+)/)?.[1];
}

/** Citation titles that are numbers or URLs become the post id or the host. */
function repairTitle(title: string, url: string): string {
	if (title !== "" && !/^\d+$/.test(title) && !/^https?:\/\//.test(title)) return title;
	const id = postId(url);
	if (id) return `x.com post ${id}`;
	return parseUrl(url)?.hostname ?? url;
}

function costOf(result: ResponsesResult): { costUsd?: number } {
	const ticks = asNumber(field(result.usage, "cost_in_usd_ticks"));
	// One tick is 1e-10 USD, inferred from the magnitude of observed costs.
	return ticks === undefined ? {} : { costUsd: ticks / 1e10 };
}

function searched(output: readonly JsonRecord[], usage: JsonRecord | undefined): boolean {
	return (
		webSearchCalls(output).length > 0 ||
		output.some((item) => field(item, "type") === "custom_tool_call") ||
		(asNumber(field(usage, "num_server_side_tools_used")) ?? 0) > 0
	);
}

/** The accounts an X-only search restricts x_search to (`x.com/golang` → `golang`). */
function allowedHandles(request: SearchRequest): string[] {
	return [...new Set(request.domains.flatMap((site) => handleOf(site) ?? []))];
}

/**
 * X cites posts as `x.com/i/status/<id>`, without the author. When x_search was restricted to exactly one account,
 * that account is the author, and the citation gets the canonical URL so that the account filter recognises it;
 * otherwise the author is unknown and the URL stays as cited.
 */
function attributePost(url: string, request: SearchRequest): string {
	const [handle, ...others] = allowedHandles(request);
	const parsed = parseUrl(url);
	if (handle === undefined || others.length > 0 || !parsed || !isXHost(parsed.hostname.toLowerCase())) return url;
	const id = parsed.pathname.match(/^\/i\/(?:web\/)?status\/(\d+)/)?.[1];
	return id ? `https://x.com/${handle}/status/${id}` : url;
}

function imageUnderstanding(entry: ProviderEntry): { enable_image_understanding?: true } {
	return field(entry.options, "enableImageUnderstanding") === true ? { enable_image_understanding: true } : {};
}

function xSearchTool(entry: ProviderEntry, request: SearchRequest): Record<string, unknown> {
	const allowed = nonEmpty(allowedHandles(request));
	// Only a whole account (`x.com/<handle>`) maps onto a handle exclusion; a post or subpage is left to the results.
	const excluded = nonEmpty(
		request.excludeDomains
			.filter((site) => isXHost(siteHost(site)) && sitePath(site).split("/").length === 2)
			.flatMap((site) => handleOf(site) ?? []),
	);
	return {
		type: "x_search",
		// x_search takes one of the two handle lists.
		allowed_x_handles: allowed,
		excluded_x_handles: allowed ? undefined : excluded,
		from_date: request.recency ? recencyDate(request.recency) : undefined,
		...imageUnderstanding(entry),
	};
}

export const sub2apiGrok: ProviderDefinition = {
	requires: ["provider", "model"],
	defaults: { timeoutMs: 180_000 },
	options: { enableImageUnderstanding: booleanOption },
	create: (entry) => ({
		search: { domains: "hard", maxCount: 0, recency: true, content: false },
		fetchExtraction: "model",
		async runSearch(request: SearchRequest, run: RunContext): Promise<ProviderSearchResult> {
			const warnings: string[] = [];
			const xOnly = request.domains.length > 0 && request.domains.every((site) => isXHost(siteHost(site)));
			let tool: Record<string, unknown>;
			if (xOnly) {
				tool = xSearchTool(entry, request);
			} else {
				tool = { type: "web_search", filters: domainFilters(request, "excluded_domains", { exclusive: true }) };
				if (request.domains.length > 0 && request.excludeDomains.length > 0) {
					warnings.push(
						`${entry.name}: excludeDomains were applied to the results, since web search cannot take both domain lists`,
					);
				}
				if (request.domains.some((site) => isXHost(siteHost(site)))) {
					warnings.push(`${entry.name}: X hosts were searched through web search rather than x_search`);
				}
				if (request.recency)
					warnings.push(`${entry.name}: recency was ignored by web search, which has no date filter`);
			}
			const result = await responses(run, {
				model: entry.model,
				instructions: SEARCH_INSTRUCTIONS,
				input: request.query,
				tools: [tool],
				// x_search rejects any include.
				...(xOnly ? {} : { include: ["web_search_call.action.sources"] }),
			});
			if (!searched(result.output, result.usage)) throw new ProviderError("no web search performed");
			const answer = stripMarkers(messageText(result.output)).trim();
			return {
				results: citedResults(result.output, repairTitle).map((hit) => ({
					...hit,
					url: xOnly ? attributePost(hit.url, request) : hit.url,
					snippet: stripMarkers(hit.snippet),
				})),
				...(answer ? { answer } : {}),
				...costOf(result),
				warnings,
			};
		},
		async runFetch(request: FetchRequest, run: RunContext): Promise<ProviderFetchResult> {
			const id = postId(request.url);
			if (id === undefined) {
				const { text, result } = await openThroughWebSearch(run, entry.model, request);
				return {
					content: stripMarkers(text).trim(),
					complete: true,
					extraction: "model",
					...costOf(result),
					warnings: [],
				};
			}
			const tool = { type: "x_search", ...imageUnderstanding(entry) };
			const result = await responses(run, {
				model: entry.model,
				input: `Fetch the X post ${request.url} (post id ${id}) and reply with its exact full text verbatim, followed by the author's @handle and the post date. Do not paraphrase.`,
				tools: [tool],
			});
			// A post x_search found shows up as a used server-side tool or a citation; an x_thread_fetch that used no tool,
			// or an answer without any tool, means the post was not retrieved.
			const used = asNumber(field(result.usage, "num_server_side_tools_used")) ?? 0;
			if (used === 0 && citations(result.output).length === 0) throw new ProviderError("post not found");
			const text = stripMarkers(messageText(result.output)).trim();
			if (text === "") throw new ProviderError("no post text returned");
			return { content: text, complete: true, extraction: "model", ...costOf(result), warnings: [] };
		},
	}),
};
