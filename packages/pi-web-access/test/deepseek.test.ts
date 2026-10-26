import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import { deepseekError, deepseekPage, deepseekResults } from "./fixtures/backends.ts";
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
/** No DeepSeek key from the developer's environment may leak into a scenario. */
const ENV = { DEEPSEEK_API_KEY: undefined };

function startDeepSeek(providers: Record<string, unknown> = { ds: { type: "deepseek", baseUrl: `${server.url}/v1` } }) {
	return startWebAccess({ config: { providers }, auth: AUTH, env: ENV });
}

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

describe("deepseek provider", () => {
	// deepseek-provider: DeepSeek endpoints and credentials.
	it("reuses Pi's DeepSeek key for search and fetch, and skips the provider without a key", async () => {
		server.route("/v1/tools/search", deepseekResults([{ url: "https://example.com/a" }]));
		server.route("/v1/tools/fetch", deepseekPage("A", "Page text"));
		pi = await startDeepSeek();
		await call(pi, "web_search", { query: "pi agent" });
		await call(pi, "web_fetch", { url: "https://example.com/a" });
		expect(server.requests.map((request) => [request.path, request.headers.authorization])).toEqual([
			["/v1/tools/search", "Bearer ds-key-0123456789"],
			["/v1/tools/fetch", "Bearer ds-key-0123456789"],
		]);
		await pi.dispose();

		pi = await startWebAccess({
			config: { providers: { ds: { type: "deepseek", baseUrl: `${server.url}/v1` } } },
			env: ENV,
		});
		const result = await call(pi, "web_search", { query: "pi agent" });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/ds failed: no credentials/);
		expect(server.requests).toHaveLength(2);
	});

	// deepseek-provider: Filters become query operators; The 128-character query budget is respected.
	it("writes domain, exclusion and recency filters as operators within the 128-character limit", async () => {
		server.route("/v1/tools/search", (request) => {
			const query = String(get(request.body, "query"));
			if (query.startsWith("budget")) {
				return deepseekResults([
					{ url: "https://one-long-domain-name.example/a" },
					{ url: "https://six-long-domain-name.example/b" },
					{ url: "https://unrelated.example/c" },
				]);
			}
			return deepseekResults([{ url: "https://reddit.com/r/rust/1" }]);
		});
		pi = await startDeepSeek();
		await call(pi, "web_search", {
			query: "rust async runtime",
			domains: ["reddit.com", "news.ycombinator.com"],
			maxResults: 5,
		});
		await call(pi, "web_search", { query: "rust async runtime", recency: "month" });
		await call(pi, "web_search", { query: "rust", excludeDomains: ["pinterest.com"] });
		const domains = ["one", "two", "three", "four", "five", "six"].map((word) => `${word}-long-domain-name.example`);
		const budget = await call(pi, "web_search", { query: "budget query about async runtimes in rust", domains });
		const words = Array.from({ length: 30 }, (_, n) => `word${n}`).join(" ");
		const long = await call(pi, "web_search", { query: words });

		const bodies = server.at("/v1/tools/search").map((request) => request.body);
		expect(bodies[0]).toEqual({ query: "rust async runtime site:reddit.com OR site:news.ycombinator.com", count: 15 });
		expect(bodies[1]).toEqual({ query: `rust async runtime after:${daysAgo(30)}`, count: 5 });
		expect(bodies[2]).toEqual({ query: "rust -site:pinterest.com", count: 5 });
		const sent = String(get(bodies[3], "query"));
		expect(sent.length).toBeLessThanOrEqual(128);
		expect(sent).toMatch(/^budget query about async runtimes in rust site:one-long-domain-name\.example OR /);
		expect(sent).not.toContain("six-long-domain-name");
		// The dropped domain is still enforced on the results; the unrelated host is not let through.
		expect(get(budget.structured, "results")).toMatchObject([
			{ url: "https://one-long-domain-name.example/a" },
			{ url: "https://six-long-domain-name.example/b" },
		]);
		const cut = String(get(bodies[4], "query"));
		expect(cut.length).toBeLessThanOrEqual(128);
		expect(words.startsWith(cut)).toBe(true);
		expect(words.charAt(cut.length)).toBe(" ");
		expect(get(long.structured, "warnings")).toEqual([
			`deepseek: the query was cut to ${cut.length} characters (the API accepts 128)`,
		]);
		expect(get(budget.structured, "warnings")).toContainEqual(
			expect.stringMatching(/site: filters for .*six-long-domain-name\.example.* applied to the results/),
		);
	});

	// deepseek-provider: Search response mapping.
	it("maps titles, snippets, dates and scores, and returns page text only when asked", async () => {
		server.route(
			"/v1/tools/search",
			deepseekResults([
				{
					url: "https://example.com/a",
					title: "A",
					snippet: "about a",
					date: "2026-09-28T16:00:00+00:00",
					score: 2.13,
					content: "x".repeat(5000),
				},
				{ url: "https://example.com/b", title: "B", snippet: "about b", summary: "summary of b" },
			]),
		);
		pi = await startDeepSeek();
		const plain = await call(pi, "web_search", { query: "q" });
		const full = await call(pi, "web_search", { query: "q", includeContent: true });
		expect(server.at("/v1/tools/search").map((request) => request.body)).toEqual([
			{ query: "q", count: 5 },
			{ query: "q", count: 5, need_content: true },
		]);
		expect(get(plain.structured, "results")).toEqual([
			{ title: "A", url: "https://example.com/a", snippet: "about a", publishedAt: "2026-09-28", score: 2.13 },
			{ title: "B", url: "https://example.com/b", snippet: "about b", score: 2.1 },
		]);
		expect(get(full.structured, "results", 0, "content")).toBe(`${"x".repeat(4000)} […]`);
		expect(get(full.structured, "results", 1, "content")).toBe("summary of b");
	});

	// deepseek-provider: Fetch response clean-up; Error classification.
	it("un-escapes fetched markdown and turns DeepSeek errors into failed attempts with their message", async () => {
		server.route(
			"/v1/tools/fetch",
			deepseekPage("Release History", "\\# Release History\n\nUse\\: git fetch \\-\\-tags"),
		);
		server.route("/v2/tools/fetch", deepseekError(404, "failed to fetch URL"));
		server.route("/v2/tools/search", deepseekError(402, "Insufficient Balance"));
		server.route("/v1/tools/search", deepseekResults([]));
		pi = await startDeepSeek({
			broken: { type: "deepseek", baseUrl: `${server.url}/v2` },
			ds: { type: "deepseek", baseUrl: `${server.url}/v1` },
		});
		const page = await call(pi, "web_fetch", { url: "https://go.dev/doc/devel/release" });
		expect(get(page.structured, "content")).toBe("# Release History\n\nUse: git fetch --tags");
		expect(get(page.structured, "extraction")).toBe("verbatim");
		expect(get(page.structured, "attempts")).toMatchObject([
			{ provider: "broken", outcome: "error", reason: expect.stringContaining("404 failed to fetch URL") },
			{ provider: "ds", outcome: "ok" },
		]);
		const search = await call(pi, "web_search", { query: "q" });
		expect(get(search.structured, "attempts", 0, "reason")).toMatch(
			/^402 account balance is insufficient: Insufficient Balance/,
		);
	});
});
