import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import { deepseekPage, exaContents, exaContentsError, exaSearch } from "./fixtures/backends.ts";
import { type FixtureServer, startServer } from "./fixtures/server.ts";
import { call, get, startWebAccess } from "./fixtures/session.ts";

let pi: Pi | undefined;
let server: FixtureServer;

beforeEach(async () => {
	server = await startServer();
});

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
	await server.close();
});

const KEY = "exa-key-0123456789";

function startExa(options: Record<string, unknown> = {}, extraProviders: Record<string, unknown> = {}) {
	return startWebAccess({
		config: { providers: { exa: { type: "exa", baseUrl: server.url, ...options }, ...extraProviders } },
		env: { EXA_API_KEY: KEY },
		auth: { deepseek: { type: "api_key", key: "ds-key-0123456789" } },
	});
}

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

describe("exa provider", () => {
	// exa-provider: Exa endpoints and credentials.
	it("authenticates with $EXA_API_KEY by default, skips without it, and moves on after a rejected key", async () => {
		server.route("/search", exaSearch([]));
		pi = await startExa();
		await call(pi, "web_search", { query: "q" });
		expect(server.at("/search")[0]?.headers["x-api-key"]).toBe(KEY);
		await pi.dispose();

		pi = await startWebAccess({
			config: { providers: { exa: { type: "exa", baseUrl: server.url } } },
			env: { EXA_API_KEY: undefined },
		});
		const missing = await call(pi, "web_search", { query: "q" });
		expect(missing.text).toBe(
			"web_search: provider exa failed: no credentials: environment variable EXA_API_KEY is not set",
		);
		expect(server.requests).toHaveLength(1);
		await pi.dispose();

		server.route("/bad/search", { status: 402, json: { error: "No API key provided", tag: "NO_API_KEY" } });
		server.route("/ds/tools/search", {
			json: { results: [{ url: "https://example.com/", title: "ok", snippet: "s" }] },
		});
		pi = await startExa({ baseUrl: `${server.url}/bad` }, { ds: { type: "deepseek", baseUrl: `${server.url}/ds` } });
		const rejected = await call(pi, "web_search", { query: "q" });
		expect(get(rejected.structured, "attempts")).toMatchObject([
			{ provider: "exa", outcome: "error", reason: "402 key rejected or missing: No API key provided" },
			{ provider: "ds", outcome: "ok" },
		]);
	});

	// exa-provider: Exa search request; Recency drops undated pages on Exa; Exa search response mapping.
	it("sends lite searches with highlights and copied filters, and maps highlights, dates and cost", async () => {
		server.route(
			"/search",
			exaSearch(
				[
					{
						url: "https://go.dev/doc/devel/release",
						title: "Release History",
						highlights: ["go1.27.3 (released 2026-10-19)"],
						publishedDate: "2026-10-19T00:00:00.000Z",
						text: "full text",
					},
					{ url: "https://go.dev/doc/untitled", title: "", text: "t".repeat(800) },
				],
				0.004,
			),
		);
		pi = await startExa({ category: "news" });
		const plain = await call(pi, "web_search", { query: "sqlite wal mode", maxResults: 5 });
		const filtered = await call(pi, "web_search", {
			query: "go",
			domains: ["go.dev/doc"],
			recency: "month",
			includeContent: true,
		});
		const [first, second] = server.at("/search").map((request) => request.body);
		expect(first).toEqual({
			query: "sqlite wal mode",
			type: "lite",
			numResults: 5,
			contents: { highlights: { maxCharacters: 400 } },
			category: "news",
		});
		expect(second).toMatchObject({
			includeDomains: ["go.dev/doc"],
			startPublishedDate: daysAgo(30),
			contents: { highlights: { maxCharacters: 400 }, text: { maxCharacters: 4000 } },
		});
		expect(get(plain.structured, "results")).toEqual([
			{
				title: "Release History",
				url: "https://go.dev/doc/devel/release",
				snippet: "go1.27.3 (released 2026-10-19)",
				publishedAt: "2026-10-19",
			},
			{ title: "https://go.dev/doc/untitled", url: "https://go.dev/doc/untitled", snippet: `${"t".repeat(500)}` },
		]);
		expect(get(plain.structured, "costUsd")).toBe(0.004);
		expect(get(plain.structured, "warnings")).toEqual([]);
		expect(get(filtered.structured, "results", 0, "content")).toBe("full text");
		expect(get(filtered.structured, "warnings")).toContain(
			"exa: Exa excludes pages without a publication date when a date filter is used",
		);
	});

	// exa-provider: Exa fetch request and freshness; Exa fetch response and per-URL errors.
	it("fetches with a one-character lookahead, labels cached copies, and reports per-URL errors", async () => {
		server.route("/contents", (request) => {
			const url = get(request.body, "urls", 0);
			if (url === "https://x.com/GoLandIDE/status/2103386967853367366")
				return exaContentsError(String(url), "SOURCE_NOT_AVAILABLE", 403);
			if (url === "https://example.com/long")
				return exaContents({ url: String(url), title: "Long", text: "l".repeat(20_001) });
			if (url === "https://arxiv.org/pdf/1706.03762")
				return exaContents({ url: String(url), title: "Attention", text: "# Attention Is All You Need" });
			return exaContents({ url: String(url), title: "Cached", text: "c".repeat(6000), source: "cached" });
		});
		server.route("/ds/tools/fetch", deepseekPage("Post", "post text"));
		pi = await startExa({}, { ds: { type: "deepseek", baseUrl: `${server.url}/ds` } });
		const cached = await call(pi, "web_fetch", { url: "https://example.com/cached" });
		expect(server.at("/contents")[0]?.body).toEqual({
			urls: ["https://example.com/cached"],
			text: { maxCharacters: 20_001 },
			maxAgeHours: 24,
			livecrawlTimeout: 15_000,
		});
		expect(cached.structured).toMatchObject({ truncated: false, totalChars: 6000, extraction: "verbatim" });
		expect(get(cached.structured, "crawledAt")).toBeUndefined();
		expect(get(cached.structured, "warnings")).toEqual([
			"exa: the page came from Exa's cache and is at most 24 hours old",
		]);

		const long = await call(pi, "web_fetch", { url: "https://example.com/long", maxChars: 20_000 });
		expect(long.structured).toMatchObject({ truncated: true, nextOffset: 20_000 });
		expect(get(long.structured, "totalChars")).toBeUndefined();
		expect(get(long.structured, "content")).toHaveLength(20_000);

		const pdf = await call(pi, "web_fetch", { url: "https://arxiv.org/pdf/1706.03762" });
		expect(pdf.structured).toMatchObject({ content: "# Attention Is All You Need", extraction: "verbatim" });
		expect(get(pdf.structured, "crawledAt")).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));

		const blocked = await call(pi, "web_fetch", { url: "https://x.com/GoLandIDE/status/2103386967853367366" });
		expect(get(blocked.structured, "attempts")).toMatchObject([
			{ provider: "exa", outcome: "error", reason: "SOURCE_NOT_AVAILABLE 403" },
			{ provider: "ds", outcome: "ok" },
		]);
	});

	// exa-provider: Exa fetch request and freshness (Fresh crawl requested); Exa rate limiting.
	it("asks for a fresh crawl when maxAgeHours is 0, and does not wait out a 429 itself", async () => {
		const requestedAt = Date.now();
		server.route("/contents", exaContents({ url: "https://example.com/", text: "fresh", source: "crawled" }));
		server.route("/search", {
			status: 429,
			headers: { "retry-after": "1" },
			json: { error: "Rate limit exceeded: 10 requests per second", tag: "RATE_LIMIT_EXCEEDED" },
		});
		server.route("/ds/tools/search", { json: { results: [] } });
		pi = await startExa({ maxAgeHours: 0 }, { ds: { type: "deepseek", baseUrl: `${server.url}/ds` } });
		const fresh = await call(pi, "web_fetch", { url: "https://example.com/" });
		expect(get(server.at("/contents")[0]?.body, "maxAgeHours")).toBe(0);
		expect(Date.parse(String(get(fresh.structured, "crawledAt")))).toBeGreaterThanOrEqual(requestedAt - 1000);
		const limited = await call(pi, "web_search", { query: "q" });
		expect(get(limited.structured, "attempts")).toMatchObject([
			{ provider: "exa", outcome: "error", reason: "429 rate limited, retry after 1 s" },
			{ provider: "ds", outcome: "ok" },
		]);
		expect(server.at("/search")).toHaveLength(1);
	});
});
