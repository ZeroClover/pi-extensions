import { postJson, statusError } from "../clients/http.ts";
import { asNumber, asRecord, asString, field, records } from "../json.ts";
import type {
	FetchRequest,
	ProviderFetchResult,
	ProviderSearchResult,
	RunContext,
	SearchHit,
	SearchRequest,
} from "../types.ts";
import { bearerHeaders, endpoint, excludedHosts, hostsOf, isoDate, recencyDate } from "./common.ts";
import type { ProviderDefinition } from "./options.ts";

const QUERY_LIMIT = 128;
const HINTS = {
	401: "invalid or missing API key",
	402: "account balance is insufficient",
	429: "rate limited",
};

interface ComposedQuery {
	query: string;
	/** The `after:` date applied to results because it did not fit into the query. */
	clientAfter?: string;
	warnings: string[];
}

/**
 * Appends `site:` (OR-joined), `-site:` and `after:` to the query, dropping operators in that order of preference
 * (`-site:` first, `after:` last) until the 128-character limit holds. Dropped filters are enforced on the results:
 * domains by the search tool, `after:` here.
 */
export function composeQuery(request: SearchRequest, now: Date): ComposedQuery {
	const warnings: string[] = [];
	let text = request.query.trim();
	if (text.length > QUERY_LIMIT) {
		const cut = text.slice(0, QUERY_LIMIT + 1).lastIndexOf(" ");
		text = text.slice(0, cut > 0 ? cut : QUERY_LIMIT).trim();
		warnings.push(`deepseek: the query was cut to ${text.length} characters (the API accepts ${QUERY_LIMIT})`);
	}
	const sites = hostsOf(request.domains);
	const excluded = excludedHosts(request.excludeDomains);
	let after = request.recency ? recencyDate(request.recency, now) : undefined;
	const compose = (): string =>
		[
			text,
			sites.map((host) => `site:${host}`).join(" OR "),
			...excluded.map((host) => `-site:${host}`),
			after ? `after:${after}` : "",
		]
			.filter((part) => part !== "")
			.join(" ");
	const dropped = { sites: [] as string[], excluded: [] as string[], after: undefined as string | undefined };
	let query = compose();
	while (query.length > QUERY_LIMIT) {
		const exclude = excluded.pop();
		if (exclude !== undefined) dropped.excluded.unshift(exclude);
		else {
			const site = sites.pop();
			if (site !== undefined) dropped.sites.unshift(site);
			else if (after !== undefined) {
				dropped.after = after;
				after = undefined;
			} else break;
		}
		query = compose();
	}
	const moved = (what: string): string =>
		`deepseek: ${what} applied to the results instead of the query (${QUERY_LIMIT}-character limit)`;
	if (dropped.excluded.length > 0) warnings.push(moved(`-site: filters for ${dropped.excluded.join(", ")}`));
	if (dropped.sites.length > 0) warnings.push(moved(`site: filters for ${dropped.sites.join(", ")}`));
	if (dropped.after !== undefined) warnings.push(moved(`recency (after:${dropped.after})`));
	return { query, ...(dropped.after === undefined ? {} : { clientAfter: dropped.after }), warnings };
}

/** Removes the backslash DeepSeek puts before markdown punctuation. */
export function unescapeMarkdown(text: string): string {
	return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

async function search(request: SearchRequest, run: RunContext): Promise<ProviderSearchResult> {
	const { query, clientAfter, warnings } = composeQuery(request, new Date());
	const { credentials } = run;
	const result = await postJson({
		url: endpoint(credentials.baseUrl, "tools/search"),
		body: {
			query,
			count: Math.min(50, Math.max(1, request.count)),
			...(request.includeContent ? { need_content: true } : {}),
		},
		headers: bearerHeaders(credentials.apiKey, credentials.headers),
		signal: run.signal,
		secrets: credentials.secrets,
	});
	if (result.status < 200 || result.status >= 300) throw statusError(result, credentials.secrets, HINTS);
	const results: SearchHit[] = [];
	for (const item of records(field(result.json, "results"))) {
		const url = asString(field(item, "url"));
		if (!url) continue;
		const publishedAt = isoDate(asString(field(item, "date")));
		if (clientAfter !== undefined && publishedAt !== undefined && publishedAt < clientAfter) continue;
		const summary = asString(field(item, "summary")) ?? "";
		const content = asString(field(item, "content")) || summary;
		const score = asNumber(field(item, "rerank_score"));
		results.push({
			title: asString(field(item, "title")) || url,
			url,
			snippet: asString(field(item, "snippet")) || summary,
			...(request.includeContent && content ? { content } : {}),
			...(publishedAt ? { publishedAt } : {}),
			...(score === undefined ? {} : { score }),
		});
	}
	return { results, warnings };
}

async function fetchPage(request: FetchRequest, run: RunContext): Promise<ProviderFetchResult> {
	const { credentials } = run;
	const result = await postJson({
		url: endpoint(credentials.baseUrl, "tools/fetch"),
		body: { url: request.url },
		headers: bearerHeaders(credentials.apiKey, credentials.headers),
		signal: run.signal,
		secrets: credentials.secrets,
	});
	if (result.status < 200 || result.status >= 300) throw statusError(result, credentials.secrets, HINTS);
	const body = asRecord(result.json);
	const title = asString(field(body, "title"));
	return {
		content: unescapeMarkdown(asString(field(body, "content")) ?? ""),
		complete: true,
		extraction: "verbatim",
		...(title ? { title } : {}),
		warnings: [],
	};
}

export const deepseek: ProviderDefinition = {
	requires: [],
	defaults: { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", timeoutMs: 60_000 },
	options: {},
	create: () => ({
		search: { domains: "soft", maxCount: 50, recency: true, content: true },
		fetchExtraction: "verbatim",
		runSearch: search,
		runFetch: fetchPage,
	}),
};
