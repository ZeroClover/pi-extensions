import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import { deepseekPage, deepseekResults, exaSearch } from "./fixtures/backends.ts";
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

const AUTH = { deepseek: { type: "api_key", key: "ds-key-0123456789" } };

function config(extra: Record<string, unknown> = {}) {
	return {
		providers: {
			ds: { type: "deepseek", baseUrl: `${server.url}/ds` },
			exa: { type: "exa", apiKey: "exa-key-0123456789", baseUrl: `${server.url}/exa` },
		},
		search: ["ds"],
		...extra,
	};
}

/** A page whose character n is predictable: blocks of "<offset>|" padded with dots. */
function page(length: number): string {
	let text = "";
	while (text.length < length) text += `${text.length}|`.padEnd(100, ".");
	return text.slice(0, length);
}

describe("web_search", () => {
	// web-search: Search parameters (Minimal call, Unknown provider name); Unified search result.
	it("searches the default chain with five results and returns the unified result as data and text", async () => {
		server.route(
			"/ds/tools/search",
			deepseekResults(
				Array.from({ length: 8 }, (_, n) => ({
					url: `https://example.com/${n}`,
					title: `Page ${n}`,
					date: "2026-10-19T16:00:00+00:00",
				})),
			),
		);
		pi = await startWebAccess({ config: config(), auth: AUTH });
		const result = await call(pi, "web_search", { query: "pi agent" });
		expect(server.at("/ds/tools/search").map((request) => request.body)).toEqual([{ query: "pi agent", count: 5 }]);
		expect(result.structured).toEqual({
			provider: "ds",
			query: "pi agent",
			results: Array.from({ length: 5 }, (_, n) => ({
				title: `Page ${n}`,
				url: `https://example.com/${n}`,
				snippet: `Snippet of https://example.com/${n}`,
				publishedAt: "2026-10-19",
				score: 2.1,
			})),
			attempts: [{ provider: "ds", outcome: "ok", latencyMs: expect.any(Number) }],
			warnings: [],
			latencyMs: expect.any(Number),
		});
		expect(result.text).toContain('Search results for "pi agent" from ds:');
		expect(result.text).toContain(
			"1. Page 0\n   https://example.com/0 (2026-10-19)\n   Snippet of https://example.com/0",
		);
		const unknown = await call(pi, "web_search", { query: "q", provider: "bing" });
		expect(unknown.isError).toBe(true);
		expect(unknown.text).toBe('unknown provider "bing"; configured providers: ds, exa');
	});

	// web-search: `site:` operators in the query count as domain filters; Stringified array arguments are accepted;
	// Unified search result (Cost reported by the provider).
	it("turns site: operators and JSON-string arrays into domain filters that rules then see", async () => {
		server.route(
			"/exa/search",
			exaSearch([{ url: "https://reddit.com/r/rust/1", publishedDate: "2026-10-19T00:00:00.000Z" }], 0.004),
		);
		pi = await startWebAccess({
			config: config({ rules: [{ name: "Reddit", sites: ["reddit.com"], search: ["exa"] }] }),
			auth: AUTH,
		});
		const operator = await call(pi, "web_search", { query: "rust async runtime site:reddit.com -site:old.reddit.com" });
		expect(get(server.at("/exa/search")[0]?.body, "query")).toBe("rust async runtime");
		expect(server.at("/exa/search")[0]?.body).toMatchObject({
			includeDomains: ["reddit.com"],
			excludeDomains: ["old.reddit.com"],
		});
		expect(get(operator.structured, "costUsd")).toBe(0.004);
		expect(get(operator.structured, "query")).toBe("rust async runtime");

		await call(pi, "web_search", { query: "go", domains: '["reddit.com", "github.com"]', provider: "exa" });
		expect(get(server.at("/exa/search")[1]?.body, "includeDomains")).toEqual(["reddit.com", "github.com"]);
	});

	// web-search: Result text is bounded.
	it("cuts a page-sized snippet to 500 characters and points to web_fetch for the rest", async () => {
		server.route("/ds/tools/search", deepseekResults([{ url: "https://example.com/a", snippet: "s".repeat(27_000) }]));
		pi = await startWebAccess({ config: config(), auth: AUTH });
		const result = await call(pi, "web_search", { query: "q" });
		expect(get(result.structured, "results", 0, "snippet")).toBe(`${"s".repeat(500)} […]`);
		expect(get(result.structured, "warnings")).toEqual([
			"some snippets or page text were truncated; web_fetch returns the full page",
		]);
		expect(get(result.structured, "costUsd")).toBeUndefined();
	});
});

describe("web_fetch", () => {
	// web-fetch: Fetch parameters (Unsupported URL scheme).
	it("refuses URLs other than http and https without contacting a provider", async () => {
		pi = await startWebAccess({ config: config(), auth: AUTH });
		const result = await call(pi, "web_fetch", { url: "ftp://example.com/file" });
		expect(result.isError).toBe(true);
		expect(result.text).toBe("only http and https URLs are supported");
		expect(server.requests).toEqual([]);
	});

	// web-fetch: Unified fetch result; Long pages continue by offset; The extraction method is labelled (Verbatim).
	it("returns long pages in windows that continue by offset, and says when the offset is past the end", async () => {
		const long = page(70_000);
		server.route("/ds/tools/fetch", (request) =>
			get(request.body, "url") === "https://example.com/long"
				? deepseekPage("Long", long)
				: deepseekPage("Short", page(6000)),
		);
		pi = await startWebAccess({ config: config(), auth: AUTH });
		const short = await call(pi, "web_fetch", { url: "https://example.com/short" });
		expect(short.structured).toEqual({
			provider: "ds",
			url: "https://example.com/short",
			title: "Short",
			content: page(6000),
			extraction: "verbatim",
			totalChars: 6000,
			truncated: false,
			attempts: [{ provider: "ds", outcome: "ok", latencyMs: expect.any(Number) }],
			warnings: [],
			latencyMs: expect.any(Number),
		});
		expect(short.text.split("\n")[0]).toBe(
			"Short - https://example.com/short via ds (verbatim), characters 0-6000 of 6000",
		);

		const first = await call(pi, "web_fetch", { url: "https://example.com/long", maxChars: 20_000 });
		expect(first.structured).toMatchObject({ truncated: true, nextOffset: 20_000, totalChars: 70_000 });
		expect(get(first.structured, "content")).toBe(long.slice(0, 20_000));
		expect(get(first.structured, "warnings")).toEqual([
			"the page continues; call web_fetch again with offset 20000 for the next part",
		]);
		const second = await call(pi, "web_fetch", { url: "https://example.com/long", offset: 20_000, maxChars: 20_000 });
		expect(get(second.structured, "content")).toBe(long.slice(20_000, 40_000));
		expect(String(get(second.structured, "content")).startsWith("20000|")).toBe(true);
		expect(get(second.structured, "nextOffset")).toBe(40_000);

		const past = await call(pi, "web_fetch", { url: "https://example.com/short", offset: 9000 });
		expect(past.structured).toMatchObject({ content: "", truncated: false });
		expect(get(past.structured, "nextOffset")).toBeUndefined();
		expect(get(past.structured, "warnings")).toEqual(["offset 9000 is past the end of the page (6000 characters)"]);
	});

	// web-fetch: Empty content is a failure.
	it("treats a page without text as a failed attempt and tries the next provider", async () => {
		server.route("/ds/tools/fetch", deepseekPage("Empty", "  \n"));
		server.route("/exa/contents", {
			json: {
				results: [{ url: "https://example.com/", title: "E", text: "exa text" }],
				statuses: [{ id: "https://example.com/", status: "success", source: "crawled" }],
			},
		});
		pi = await startWebAccess({ config: config(), auth: AUTH });
		const result = await call(pi, "web_fetch", { url: "https://example.com/" });
		expect(get(result.structured, "attempts")).toMatchObject([
			{ provider: "ds", outcome: "error", reason: "no text returned" },
			{ provider: "exa", outcome: "ok" },
		]);
		expect(get(result.structured, "content")).toBe("exa text");
	});
});
