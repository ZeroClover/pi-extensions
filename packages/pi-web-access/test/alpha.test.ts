import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import { alphaEmpty, alphaFailure, alphaOpen, alphaSearch, deepseekPage, openLineno } from "./fixtures/backends.ts";
import { type FixtureServer, startServer } from "./fixtures/server.ts";
import { call, get, piProvider, startWebAccess } from "./fixtures/session.ts";

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

const PATH = "/v1/alpha/search";

function startAlpha(options: Record<string, unknown> = {}) {
	return startWebAccess({
		models: { gw: piProvider(`${server.url}/v1`, "gpt-test", { key: "gw-key-0123456789" }) },
		config: {
			providers: {
				alpha: { type: "sub2api-search", provider: "gw", model: "gpt-test", ...options },
				ds: { type: "deepseek", baseUrl: `${server.url}/ds` },
			},
			search: ["alpha"],
		},
		auth: { deepseek: { type: "api_key", key: "ds-key-0123456789" } },
	});
}

describe("sub2api-search provider", () => {
	// sub2api-providers: `sub2api-search` searches through the alpha endpoint; Alpha search results.
	it("sends one filtered search_query per request and maps its text results", async () => {
		server.route(
			PATH,
			alphaSearch([
				{
					url: "https://go.dev/doc/devel/release",
					title: "Release History",
					snippet: "This page summarizes the changes",
				},
				{ url: "https://go.dev/dl/", title: "All releases", snippet: "Stable versions" },
				{ url: "https://go.dev/doc/go1.27", title: "Go 1.27 Release Notes", snippet: "Go 1.27" },
			]),
		);
		pi = await startAlpha({ userLocation: { country: "JP", city: "Tokyo" } });
		const result = await call(pi, "web_search", {
			query: "latest stable Go release",
			domains: ["go.dev"],
			excludeDomains: ["golang.google.cn"],
			recency: "month",
		});
		await call(pi, "web_search", { query: "again" });
		const [first, second] = server.at(PATH).map((request) => request.body);
		expect(first).toEqual({
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			model: "gpt-test",
			commands: {
				search_query: [{ q: "latest stable Go release", recency: 30, domains: ["go.dev"] }],
				response_length: "short",
			},
			settings: {
				filters: { blocked_domains: ["golang.google.cn"] },
				user_location: { type: "approximate", country: "JP", city: "Tokyo" },
			},
		});
		expect(get(second, "id")).not.toBe(get(first, "id"));
		expect(get(result.structured, "results")).toEqual([
			{
				title: "Release History",
				url: "https://go.dev/doc/devel/release",
				snippet: "This page summarizes the changes",
			},
			{ title: "All releases", url: "https://go.dev/dl/", snippet: "Stable versions" },
			{ title: "Go 1.27 Release Notes", url: "https://go.dev/doc/go1.27", snippet: "Go 1.27" },
		]);
		expect(get(result.structured, "answer")).toBeUndefined();
	});

	// sub2api-providers: Alpha search results (No results, Parameter rejected).
	it("treats Empty search results as zero results and a 400 with a code as a failure naming it", async () => {
		server.route(PATH, alphaEmpty, {
			status: 400,
			json: {
				error: {
					message: "Unknown parameter: 'settings.foo'.",
					type: "invalid_request_error",
					param: "settings.foo",
					code: "unknown_parameter",
				},
			},
		});
		pi = await startAlpha();
		const empty = await call(pi, "web_search", { query: "nothing" });
		expect(empty.isError).toBe(false);
		expect(get(empty.structured, "results")).toEqual([]);
		const rejected = await call(pi, "web_search", { query: "q" });
		expect(rejected.text).toBe(
			"web_search: provider alpha failed: 400 unknown_parameter: Unknown parameter: 'settings.foo'.",
		);
	});

	// sub2api-providers: `sub2api-search` fetches through the alpha `open` command; web-fetch: Freshness is reported.
	it("rebuilds an opened page from its numbered lines with title, final URL and crawl age", async () => {
		const url = "https://go.dev/doc/devel/release";
		const lines = [
			"【0†iframe†www.googletagmanager.com】 【1†Image】",
			"",
			"# Release History",
			"See the 【57†Go 1.24.2 milestone†github.com】 for details.",
		];
		server.route(
			PATH,
			alphaOpen({
				url,
				title: "Release History - The Go Programming Language",
				crawled: "3 weeks ago",
				totalLines: 4,
				line: (n) => lines[n] ?? "",
			}),
		);
		pi = await startAlpha();
		const result = await call(pi, "web_fetch", { url: "http://go.dev/doc/devel/release" });
		expect(get(server.at(PATH)[0]?.body, "commands")).toEqual({
			open: [{ ref_id: "http://go.dev/doc/devel/release" }],
			response_length: "long",
		});
		expect(result.structured).toMatchObject({
			provider: "alpha",
			title: "Release History - The Go Programming Language",
			finalUrl: url,
			crawledAt: "3 weeks ago",
			extraction: "verbatim",
			content: "iframe Image\n\n# Release History\nSee the Go 1.24.2 milestone for details.",
			truncated: false,
		});
		expect(get(result.structured, "warnings")).toEqual([]);
	});

	// sub2api-providers: Alpha fetch pagination (Multi-window page, PDF).
	it("pages through overlapping windows so that every line appears once, and keeps PDF page breaks", async () => {
		const url = "https://go.dev/doc/devel/release";
		const line = (n: number): string => `line ${n} `.padEnd(100, "-");
		server.route(PATH, alphaOpen({ url, title: "Release History", crawled: "today", totalLines: 644, line }));
		pi = await startAlpha();
		const whole = await call(pi, "web_fetch", { url, maxChars: 100_000 });
		expect(server.at(PATH).map(openLineno)).toEqual([undefined, 200, 340, 480, 620]);
		expect(get(whole.structured, "content")).toBe(Array.from({ length: 644 }, (_, n) => line(n)).join("\n"));
		expect(whole.structured).toMatchObject({ truncated: false, totalChars: 644 * 101 - 1 });

		server.requests.length = 0;
		const part = await call(pi, "web_fetch", { url });
		expect(server.at(PATH).map(openLineno)).toEqual([undefined]);
		expect(part.structured).toMatchObject({ truncated: true, nextOffset: 20_000 });
		expect(get(part.structured, "totalChars")).toBeUndefined();

		server.route(
			PATH,
			alphaOpen({
				url: "https://arxiv.org/pdf/1706.03762",
				title: "",
				crawled: "today",
				totalLines: 4,
				line: (n) => `text ${n}`,
				page: (n) => (n < 2 ? 0 : 1),
			}),
		);
		const pdf = await call(pi, "web_fetch", { url: "https://arxiv.org/pdf/1706.03762" });
		expect(get(pdf.structured, "content")).toBe("## Page 1\ntext 0\ntext 1\n## Page 2\ntext 2\ntext 3");
		expect(get(pdf.structured, "title")).toBeUndefined();
		expect(get(pdf.structured, "extraction")).toBe("verbatim");
	});

	// sub2api-providers: Alpha fetch pagination (Fetch failure inside a 200 response, Page not in the index).
	// web-fetch: Empty content is a failure (Provider returns a failure page as 200).
	it("recognises failures the endpoint reports inside HTTP 200 and falls through to the next provider", async () => {
		server.route(PATH, (request) => {
			const ref = String(get(request.body, "commands", "open", 0, "ref_id"));
			return ref.includes("x.com")
				? alphaFailure(ref, `Failed to fetch ${ref}: (403) Forbidden`)
				: alphaFailure(ref, `URL ${ref} is not accessible via this tool.`);
		});
		server.route("/ds/tools/fetch", deepseekPage("Fallback", "fallback text"));
		pi = await startAlpha();
		const forbidden = await call(pi, "web_fetch", { url: "https://x.com/golang" });
		expect(get(forbidden.structured, "attempts")).toMatchObject([
			{ provider: "alpha", outcome: "error", reason: "403 Forbidden" },
			{ provider: "ds", outcome: "ok" },
		]);
		server.route(
			PATH,
			alphaFailure(
				"https://example.com/",
				"Failed to fetch https://example.com/: (401) Invalid API key gw-key-0123456789",
			),
		);
		const echoed = await call(pi, "web_fetch", { url: "https://example.com/" });
		expect(get(echoed.structured, "attempts", 0, "reason")).toBe("401 Invalid API key <redacted>");
		server.route(PATH, (request) => {
			const ref = String(get(request.body, "commands", "open", 0, "ref_id"));
			return alphaFailure(ref, `URL ${ref} is not accessible via this tool.`);
		});
		const unindexed = await call(pi, "web_fetch", { url: "https://zhuanlan.zhihu.com/p/1900000000000000000" });
		expect(get(unindexed.structured, "attempts", 0)).toMatchObject({
			provider: "alpha",
			outcome: "error",
			reason: "not indexed",
		});
		expect(get(unindexed.structured, "content")).toBe("fallback text");
	});

	// web-fetch: Long pages continue by offset, when a provider cannot reach the requested offset.
	it("hands a continuation the alpha window limit cannot reach to the next provider instead of ending the page", async () => {
		const url = "https://example.com/long-listing";
		server.route(
			PATH,
			alphaOpen({ url, title: "Listing", crawled: "today", totalLines: 10_000, line: (n) => `l${n}` }),
		);
		server.route("/ds/tools/fetch", deepseekPage("Listing", "x".repeat(200_000)));
		pi = await startAlpha();
		const first = await call(pi, "web_fetch", { url, maxChars: 100_000 });
		expect(get(first.structured, "provider")).toBe("alpha");
		expect(first.structured).toMatchObject({ truncated: true });
		const nextOffset = get(first.structured, "nextOffset");
		expect(typeof nextOffset).toBe("number");
		const second = await call(pi, "web_fetch", { url, offset: Number(nextOffset), maxChars: 100_000 });
		expect(get(second.structured, "attempts")).toMatchObject([
			{ provider: "alpha", outcome: "error", reason: expect.stringMatching(/^could not reach offset \d+/) },
			{ provider: "ds", outcome: "ok" },
		]);
		expect(String(get(second.structured, "content")).length).toBeGreaterThan(0);
	});
});
