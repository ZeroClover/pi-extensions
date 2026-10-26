/** Unified request and result types shared by the tools, the routing engine, and the provider adapters. */

export const RECENCIES = ["day", "week", "month", "year"] as const;
export type Recency = (typeof RECENCIES)[number];

export const PROVIDER_TYPES = [
	"sub2api-search",
	"sub2api-codex",
	"sub2api-claude",
	"sub2api-grok",
	"deepseek",
	"exa",
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export type Capability = "search" | "fetch";
export type Extraction = "verbatim" | "model";

/** What the search tool asks an adapter for, after `site:` extraction and normalisation. */
export interface SearchRequest {
	query: string;
	/** Site patterns: `host` or `host/path`, lower-case. */
	domains: string[];
	excludeDomains: string[];
	recency?: Recency;
	/** How many results to ask the backend for; the tool cuts to the caller's `maxResults` afterwards. */
	count: number;
	includeContent: boolean;
}

export type SearchHit = {
	title: string;
	url: string;
	snippet: string;
	content?: string;
	publishedAt?: string;
	score?: number;
};

export interface ProviderSearchResult {
	results: SearchHit[];
	answer?: string;
	costUsd?: number;
	warnings: string[];
}

export interface FetchRequest {
	url: string;
	offset: number;
	maxChars: number;
}

export interface ProviderFetchResult {
	/** Page text from its start; at least `offset + maxChars` characters unless the page ends earlier. */
	content: string;
	/** Whether `content` reaches the end of the page. */
	complete: boolean;
	extraction: Extraction;
	title?: string;
	finalUrl?: string;
	crawledAt?: string;
	costUsd?: number;
	warnings: string[];
}

export interface SearchCapabilities {
	/** `soft` when the backend treats domain filters as a preference, so more results are requested. */
	domains: "hard" | "soft";
	/** The most results one request may ask for; 0 when the backend takes no count. */
	maxCount: number;
	recency: boolean;
	content: boolean;
}

/** Resolved credentials for one attempt. */
export interface Credentials {
	apiKey?: string;
	headers: Record<string, string>;
	baseUrl: string;
	/** Values to redact from any error text. */
	secrets: string[];
}

export interface RunContext {
	credentials: Credentials;
	signal: AbortSignal;
}

export interface WebProvider {
	readonly search: SearchCapabilities;
	readonly fetchExtraction: Extraction;
	runSearch(request: SearchRequest, run: RunContext): Promise<ProviderSearchResult>;
	runFetch(request: FetchRequest, run: RunContext): Promise<ProviderFetchResult>;
}

export type AttemptOutcome = "ok" | "empty" | "error" | "skipped";
export const ATTEMPT_OUTCOMES = ["ok", "empty", "error", "skipped"] as const;

export type Attempt = {
	provider: string;
	outcome: AttemptOutcome;
	reason?: string;
	latencyMs?: number;
};

/** A failed attempt: the request was sent or attempted and failed. */
export class ProviderError extends Error {}

/** A provider that cannot serve this call and was passed over without a request. */
export class ProviderSkip extends Error {}

/** One validated provider instance from the configuration file. */
export interface ProviderEntry {
	name: string;
	type: ProviderType;
	/** The Pi provider whose credentials and base URL are reused. */
	provider?: string;
	model?: string;
	/** A key expression: literal, `$NAME`, `${NAME}`, or `!command`. */
	apiKey?: string;
	baseUrl?: string;
	timeoutMs: number;
	/** Type-specific options, validated by the type's option specs. */
	options: Record<string, unknown>;
}
