import { postJson, statusError } from "../clients/http.ts";
import { asArray, asNumber, asRecord, asString, field, records } from "../json.ts";
import {
	type FetchRequest,
	ProviderError,
	type ProviderFetchResult,
	type ProviderSearchResult,
	type RunContext,
	type SearchHit,
	type SearchRequest,
} from "../types.ts";
import { endpoint, isoDate, mergeHeaders, nonEmpty, recencyDate } from "./common.ts";
import { enumOption, integerOption, numberOption, type ProviderDefinition, stringOption } from "./options.ts";

const CATEGORIES = ["company", "publication", "news", "personal site", "financial report", "people"];
const DEFAULT_MAX_AGE_HOURS = 24;
const HINTS = { 401: "key rejected or missing", 402: "key rejected or missing" };

function headers(run: RunContext): Record<string, string> {
	return mergeHeaders(run.credentials.apiKey ? { "x-api-key": run.credentials.apiKey } : {}, run.credentials.headers);
}

async function post(run: RunContext, path: string, body: unknown): Promise<unknown> {
	const { credentials } = run;
	const result = await postJson({
		url: endpoint(credentials.baseUrl, path),
		body,
		headers: headers(run),
		signal: run.signal,
		secrets: credentials.secrets,
	});
	if (result.status === 429) {
		const retryAfter = result.headers.get("retry-after");
		throw new ProviderError(`429 rate limited${retryAfter ? `, retry after ${retryAfter} s` : ""}`);
	}
	if (result.status < 200 || result.status >= 300) throw statusError(result, credentials.secrets, HINTS);
	return result.json;
}

export const exa: ProviderDefinition = {
	requires: [],
	defaults: { apiKey: "$EXA_API_KEY", baseUrl: "https://api.exa.ai", timeoutMs: 60_000 },
	options: {
		searchType: enumOption(["lite", "auto"]),
		category: enumOption(CATEGORIES),
		maxAgeHours: integerOption(0, 8760),
	},
	create: (entry) => ({
		search: { domains: "hard", maxCount: 100, recency: true, content: true },
		fetchExtraction: "verbatim",
		async runSearch(request: SearchRequest, run: RunContext): Promise<ProviderSearchResult> {
			const warnings: string[] = [];
			if (request.recency) {
				warnings.push(`${entry.name}: Exa excludes pages without a publication date when a date filter is used`);
			}
			const body = {
				query: request.query,
				type: stringOption(entry, "searchType") ?? "lite",
				numResults: request.count,
				contents: {
					highlights: { maxCharacters: 400 },
					text: request.includeContent ? { maxCharacters: 4000 } : undefined,
				},
				includeDomains: nonEmpty(request.domains),
				excludeDomains: nonEmpty(request.excludeDomains),
				startPublishedDate: request.recency ? recencyDate(request.recency) : undefined,
				category: stringOption(entry, "category"),
			};
			const json = asRecord(await post(run, "search", body));
			const results: SearchHit[] = records(field(json, "results")).flatMap((item) => {
				const url = asString(field(item, "url"));
				if (!url) return [];
				const text = asString(field(item, "text"));
				const highlights = asArray(field(item, "highlights")).filter(
					(value): value is string => typeof value === "string",
				);
				const snippet = highlights.join(" … ") || asString(field(item, "summary")) || (text ?? "").slice(0, 500);
				const publishedAt = isoDate(asString(field(item, "publishedDate")));
				return [
					{
						title: asString(field(item, "title")) || url,
						url,
						snippet,
						...(request.includeContent && text ? { content: text } : {}),
						...(publishedAt ? { publishedAt } : {}),
					},
				];
			});
			const costUsd = asNumber(field(field(json, "costDollars"), "total"));
			return { results, warnings, ...(costUsd === undefined ? {} : { costUsd }) };
		},
		async runFetch(request: FetchRequest, run: RunContext): Promise<ProviderFetchResult> {
			const maxAgeHours = numberOption(entry, "maxAgeHours") ?? DEFAULT_MAX_AGE_HOURS;
			const window = request.offset + request.maxChars;
			const requestedAt = new Date().toISOString();
			const json = asRecord(
				await post(run, "contents", {
					urls: [request.url],
					// One character past the window tells whether the page continues.
					text: { maxCharacters: window + 1 },
					maxAgeHours,
					livecrawlTimeout: 15_000,
				}),
			);
			const status = records(field(json, "statuses"))[0];
			if (asString(field(status, "status")) === "error") {
				const error = asRecord(field(status, "error"));
				const parts = [asString(field(error, "tag")), asNumber(field(error, "httpStatusCode"))].filter(
					(part) => part !== undefined,
				);
				throw new ProviderError(parts.length > 0 ? parts.join(" ") : "fetch failed");
			}
			const page = records(field(json, "results"))[0];
			const content = asString(field(page, "text")) ?? "";
			const title = asString(field(page, "title"));
			const costUsd = asNumber(field(field(json, "costDollars"), "total"));
			const warnings: string[] = [];
			const source = asString(field(status, "source"));
			if (source === "cached")
				warnings.push(`${entry.name}: the page came from Exa's cache and is at most ${maxAgeHours} hours old`);
			return {
				content,
				complete: content.length <= window,
				extraction: "verbatim",
				...(title ? { title } : {}),
				...(source === "crawled" ? { crawledAt: requestedAt } : {}),
				...(costUsd === undefined ? {} : { costUsd }),
				warnings,
			};
		},
	}),
};
