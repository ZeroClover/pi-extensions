import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isRecord, parseJson } from "./json.ts";
import { ChainError, planChain, runChain } from "./routing.ts";
import { normalizeSite, normalizeUrl, passesFilters } from "./sites.ts";
import type { WebAccessState } from "./state.ts";
import {
	ATTEMPT_OUTCOMES,
	type Attempt,
	ProviderError,
	RECENCIES,
	type SearchHit,
	type SearchRequest,
} from "./types.ts";

const DEFAULT_MAX_RESULTS = 5;
const SNIPPET_LIMIT = 500;
const CONTENT_LIMIT = 4000;
export const TRUNCATION_MARKER = " […]";

const parameters = Type.Object({
	query: Type.String({ description: "Search query" }),
	domains: Type.Optional(
		Type.Array(Type.String(), { description: "Only these sites: host or host/path, e.g. go.dev/doc, x.com/<handle>" }),
	),
	excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Sites to leave out" })),
	recency: Type.Optional(StringEnum(RECENCIES, { description: "Only pages from the last day, week, month or year" })),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Number of results, default 5" })),
	includeContent: Type.Optional(Type.Boolean({ description: "Also return page text excerpts" })),
	provider: Type.Optional(Type.String({ description: "Configured provider name; only when the user asks for one" })),
});

type SearchParams = Static<typeof parameters>;

const attemptSchema = Type.Object({
	provider: Type.String(),
	outcome: StringEnum(ATTEMPT_OUTCOMES),
	reason: Type.Optional(Type.String()),
	latencyMs: Type.Optional(Type.Number()),
});

const outputSchema = Type.Object({
	provider: Type.String(),
	query: Type.String(),
	answer: Type.Optional(Type.String()),
	results: Type.Array(
		Type.Object({
			title: Type.String(),
			url: Type.String(),
			snippet: Type.String(),
			content: Type.Optional(Type.String()),
			publishedAt: Type.Optional(Type.String()),
			score: Type.Optional(Type.Number()),
		}),
	),
	attempts: Type.Array(attemptSchema),
	warnings: Type.Array(Type.String()),
	costUsd: Type.Optional(Type.Number()),
	latencyMs: Type.Number(),
});

type SearchOutput = Static<typeof outputSchema>;

/** Parses `domains` and `excludeDomains` sent as JSON-encoded strings, which Pi would otherwise wrap into one entry. */
function prepareArguments(args: unknown): SearchParams {
	const prepared = isRecord(args) ? { ...args } : args;
	if (isRecord(prepared)) {
		for (const key of ["domains", "excludeDomains"]) {
			const value = prepared[key];
			if (typeof value !== "string") continue;
			const parsed = parseJson(value);
			prepared[key] = Array.isArray(parsed) ? parsed : [value];
		}
	}
	const converted = Value.Convert(parameters, prepared);
	if (Value.Check(parameters, converted)) return converted;
	const problems = [...Value.Errors(parameters, converted)].map(
		(error) => `${error.instancePath || "/"} ${error.message}`,
	);
	throw new Error(`Invalid web_search arguments: ${problems.join("; ")}`);
}

const SITE_OPERATOR = /(^|\s)(-?)site:(\S+)/g;

/** Moves `site:` and `-site:` operators out of the query into the domain filters. */
function extractSites(params: SearchParams): { query: string; domains: string[]; excludeDomains: string[] } {
	const domains: string[] = [];
	const excludeDomains: string[] = [];
	const add = (list: string[], entry: string): void => {
		const site = normalizeSite(entry);
		if (site !== undefined && !list.includes(site)) list.push(site);
	};
	for (const entry of params.domains ?? []) add(domains, entry);
	for (const entry of params.excludeDomains ?? []) add(excludeDomains, entry);
	const query = params.query
		.replace(SITE_OPERATOR, (_match, lead: string, minus: string, site: string) => {
			add(minus === "-" ? excludeDomains : domains, site);
			return lead;
		})
		.replace(/\s+/g, " ")
		.trim();
	return { query, domains, excludeDomains };
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	return text.length > limit
		? { text: `${text.slice(0, limit)}${TRUNCATION_MARKER}`, truncated: true }
		: { text, truncated: false };
}

/** Domain filtering, URL normalisation, deduplication, the result cut, and text bounds. */
function postProcess(
	hits: readonly SearchHit[],
	options: { domains: string[]; excludeDomains: string[]; maxResults: number; provider: string },
	warnings: string[],
): SearchHit[] {
	const kept = hits.filter((hit) => passesFilters(hit.url, options.domains, options.excludeDomains));
	const dropped = hits.length - kept.length;
	if (dropped > 0) {
		warnings.push(
			`${options.provider}: ${dropped} result${dropped === 1 ? "" : "s"} outside the domain filters dropped`,
		);
	}
	const seen = new Set<string>();
	const results: SearchHit[] = [];
	let truncated = false;
	for (const hit of kept) {
		const url = normalizeUrl(hit.url);
		if (seen.has(url)) continue;
		seen.add(url);
		const snippet = truncate(hit.snippet, SNIPPET_LIMIT);
		const content = hit.content === undefined ? undefined : truncate(hit.content, CONTENT_LIMIT);
		truncated ||= snippet.truncated || content?.truncated === true;
		results.push({ ...hit, url, snippet: snippet.text, ...(content ? { content: content.text } : {}) });
		if (results.length >= options.maxResults) break;
	}
	if (truncated) warnings.push("some snippets or page text were truncated; web_fetch returns the full page");
	return results;
}

function renderAttempts(attempts: readonly Attempt[]): string {
	return attempts
		.map((attempt) => `${attempt.provider} ${attempt.outcome}${attempt.reason ? ` (${attempt.reason})` : ""}`)
		.join("; ");
}

function render(output: SearchOutput): string {
	const lines = [`Search results for "${output.query}" from ${output.provider}:`];
	if (output.answer) lines.push("", `Answer: ${output.answer}`);
	lines.push("");
	if (output.results.length === 0) lines.push("No results.");
	output.results.forEach((result, index) => {
		lines.push(
			`${index + 1}. ${result.title}`,
			`   ${result.url}${result.publishedAt ? ` (${result.publishedAt})` : ""}`,
		);
		if (result.snippet) lines.push(`   ${result.snippet.replace(/\n+/g, " ")}`);
		if (result.content) lines.push(`   Content: ${result.content}`);
	});
	for (const warning of output.warnings) lines.push(`Note: ${warning}`);
	if (output.attempts.length > 1) lines.push(`Tried: ${renderAttempts(output.attempts)}`);
	return lines.join("\n");
}

function unknownProvider(state: WebAccessState, name: string): Error {
	const names = state.config.providers.map((entry) => entry.name);
	return new Error(`unknown provider "${name}"; configured providers: ${names.join(", ") || "(none)"}`);
}

export function createSearchTool(state: WebAccessState) {
	return defineTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web through the configured providers and return results with titles, URLs and snippets.",
		promptSnippet: "web_search: search the web; filter by site with domains",
		promptGuidelines: [
			"web_search: use domains to target a site (x.com/<handle> for an account's posts) and provider only when the user names one.",
		],
		parameters,
		outputSchema,
		prepareArguments,
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const started = performance.now();
			if (params.provider !== undefined && !state.entry(params.provider)) throw unknownProvider(state, params.provider);
			const { query, domains, excludeDomains } = extractSites(params);
			if (query === "") throw new Error("the query is empty once site: operators are removed");
			const plan = planChain(state.config, { capability: "search", domains }, params.provider);
			if (plan.chain.length === 0) {
				throw new Error(`no search provider is configured; add providers to ${state.displayPath()}`);
			}
			const maxResults = params.maxResults ?? DEFAULT_MAX_RESULTS;
			const includeContent = params.includeContent ?? false;
			const { recency } = params;
			try {
				const outcome = await runChain(
					plan,
					async (entry, attemptSignal) => {
						const credentials = await state.resolveCredentials(entry, ctx.modelRegistry, attemptSignal);
						const adapter = state.adapter(entry);
						const { search } = adapter;
						const warnings: string[] = [];
						if (recency && !search.recency)
							warnings.push(`${entry.name}: recency was ignored, the provider has no date filter`);
						if (includeContent && !search.content) {
							warnings.push(`${entry.name}: includeContent was ignored, the provider returns no page text`);
						}
						const wanted = search.domains === "soft" && domains.length > 0 ? maxResults * 3 : maxResults;
						const request: SearchRequest = {
							query,
							domains,
							excludeDomains,
							...(recency ? { recency } : {}),
							count: search.maxCount > 0 ? Math.min(wanted, search.maxCount) : wanted,
							includeContent: includeContent && search.content,
						};
						const result = await adapter.runSearch(request, { credentials, signal: attemptSignal });
						warnings.push(...result.warnings);
						const results = postProcess(
							result.results,
							{ domains, excludeDomains, maxResults, provider: entry.name },
							warnings,
						);
						return {
							outcome: domains.length > 0 && results.length === 0 ? "empty" : "ok",
							value: { results, warnings, answer: result.answer, costUsd: result.costUsd },
						};
					},
					{
						signal,
						onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined }),
					},
				);
				const { value } = outcome;
				const output: SearchOutput = {
					provider: outcome.provider,
					query,
					...(value.answer ? { answer: value.answer } : {}),
					results: value.results,
					attempts: outcome.attempts,
					warnings: value.warnings,
					...(value.costUsd === undefined ? {} : { costUsd: value.costUsd }),
					latencyMs: Math.round(performance.now() - started),
				};
				return { content: [{ type: "text", text: render(output) }], structuredContent: output, details: undefined };
			} catch (error) {
				if (error instanceof ChainError || error instanceof ProviderError)
					throw new Error(`web_search: ${error.message}`);
				throw error;
			}
		},
	});
}
