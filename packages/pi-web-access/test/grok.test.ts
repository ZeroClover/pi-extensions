import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import {
	customToolCall,
	deepseekPage,
	message,
	openPageCall,
	responsesStream,
	webSearchCall,
} from "./fixtures/backends.ts";
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

const PATH = "/xai/v1/responses";
const POST = "https://x.com/GoLandIDE/status/2103386967853367366";

function startGrok(options: Record<string, unknown> = {}) {
	return startWebAccess({
		models: { xai: piProvider(`${server.url}/xai/v1`, "grok-test", { key: "xai-key-0123456789" }) },
		config: {
			providers: {
				grok: { type: "sub2api-grok", provider: "xai", model: "grok-test", ...options },
				ds: { type: "deepseek", baseUrl: `${server.url}/ds` },
			},
		},
		auth: { deepseek: { type: "api_key", key: "ds-key-0123456789" } },
	});
}

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

describe("sub2api-grok provider", () => {
	// sub2api-providers: `sub2api-grok` routes X searches to `x_search` and others to `web_search`.
	it("uses x_search for X-only domains and web_search otherwise, with the matching filters", async () => {
		server.route(
			PATH,
			responsesStream([customToolCall("x_keyword_search", { query: "from:golang" }), message("Posts.")]),
		);
		pi = await startGrok();
		await call(pi, "web_search", { query: "go news", domains: ["x.com/golang"], recency: "month" });
		await call(pi, "web_search", { query: "go", domains: ["github.com"], excludeDomains: ["reddit.com"] });
		const mixed = await call(pi, "web_search", { query: "go", domains: ["x.com/golang", "go.dev"] });
		await call(pi, "web_search", { query: "go", excludeDomains: ["reddit.com"] });
		const bodies = server.at(PATH).map((request) => request.body);
		expect(bodies[0]).toEqual({
			model: "grok-test",
			instructions: expect.any(String),
			input: "go news",
			tools: [{ type: "x_search", allowed_x_handles: ["golang"], from_date: daysAgo(30) }],
			store: false,
			stream: true,
		});
		expect(get(bodies[1], "tools")).toEqual([{ type: "web_search", filters: { allowed_domains: ["github.com"] } }]);
		expect(get(bodies[1], "include")).toEqual(["web_search_call.action.sources"]);
		expect(get(bodies[2], "tools")).toEqual([
			{ type: "web_search", filters: { allowed_domains: ["x.com", "go.dev"] } },
		]);
		expect(get(mixed.structured, "warnings")).toEqual([
			"grok: X hosts were searched through web search rather than x_search",
		]);
		expect(get(bodies[3], "tools")).toEqual([{ type: "web_search", filters: { excluded_domains: ["reddit.com"] } }]);
	});

	// web-search: Domain filters are enforced client-side; sub2api-providers: `sub2api-grok` routes X searches to
	// `x_search`. X cites posts as `x.com/i/status/<id>`, without the author.
	it("attributes handle-less post citations only to the one account an x_search was restricted to", async () => {
		server.route(
			PATH,
			responsesStream([
				customToolCall("x_keyword_search", { query: "from:golang" }),
				message("Posts.", [
					{ url: "https://x.com/i/status/2112389486977933621", title: "https://x.com/i/status/2112389486977933621" },
					{ url: "https://x.com/golang/status/2112905560152486376", title: "1" },
				]),
			]),
		);
		pi = await startGrok();
		const urls = async (args: Record<string, string | string[]>): Promise<unknown> => {
			const results = get((await call(pi as Pi, "web_search", { query: "go", ...args })).structured, "results");
			return Array.isArray(results) ? results.map((result) => get(result, "url")) : results;
		};
		const attributed = [
			"https://x.com/golang/status/2112389486977933621",
			"https://x.com/golang/status/2112905560152486376",
		];
		expect(await urls({ domains: ["x.com/golang"] })).toEqual(attributed);
		expect(await urls({ domains: ["twitter.com/golang"] })).toEqual(attributed);
		expect(get(server.at(PATH)[1]?.body, "tools")).toEqual([{ type: "x_search", allowed_x_handles: ["golang"] }]);
		expect(await urls({ domains: ["twitter.com"] })).toEqual([
			"https://x.com/i/status/2112389486977933621",
			"https://x.com/golang/status/2112905560152486376",
		]);
		// With two accounts, or through web search, the author of a handle-less post is unknown.
		expect(await urls({ domains: ["x.com/golang", "x.com/rob_pike"] })).toEqual([
			"https://x.com/golang/status/2112905560152486376",
		]);
		expect(await urls({ domains: ["x.com/golang", "go.dev"] })).toEqual([
			"https://x.com/golang/status/2112905560152486376",
		]);
		expect(await urls({ domains: ["x.com"], excludeDomains: ["x.com/golang"] })).toEqual([
			"https://x.com/i/status/2112389486977933621",
		]);
		expect(get(server.at(PATH).at(-1)?.body, "tools", 0, "excluded_x_handles")).toEqual(["golang"]);
		// Excluding one post or subpage must not exclude the whole account at the provider, and removes only that post,
		// under either of its URL forms.
		expect(await urls({ domains: ["x.com"], excludeDomains: ["x.com/golang/status/2112905560152486376"] })).toEqual([
			"https://x.com/i/status/2112389486977933621",
		]);
		expect(get(server.at(PATH).at(-1)?.body, "tools")).toEqual([{ type: "x_search" }]);
		expect(await urls({ domains: ["x.com"], excludeDomains: ["x.com/golang/status/2112389486977933621"] })).toEqual([
			"https://x.com/golang/status/2112905560152486376",
		]);
	});

	// provider-routing: Unsupported options degrade with a warning (Grok web search takes one domain list).
	it("warns when web search on Grok cannot take the exclusions along with the domains", async () => {
		server.route(PATH, responsesStream([webSearchCall(["https://github.com/golang/go"]), message("ok")]));
		pi = await startGrok();
		const result = await call(pi, "web_search", {
			query: "go",
			domains: ["github.com"],
			excludeDomains: ["gist.github.com"],
		});
		expect(get(server.at(PATH)[0]?.body, "tools")).toEqual([
			{ type: "web_search", filters: { allowed_domains: ["github.com"] } },
		]);
		expect(get(result.structured, "warnings")).toContain(
			"grok: excludeDomains were applied to the results, since web search cannot take both domain lists",
		);
		const suffixOnly = await call(pi, "web_search", {
			query: "政策",
			domains: [".cn"],
			excludeDomains: ["reddit.com"],
		});
		expect(get(server.at(PATH).at(-1)?.body, "tools")).toEqual([{ type: "web_search" }]);
		expect(get(suffixOnly.structured, "warnings")).toContain(
			"grok: excludeDomains were applied to the results, since web search cannot take both domain lists",
		);
		const pathOnly = await call(pi, "web_search", {
			query: "go",
			domains: ["github.com"],
			excludeDomains: ["github.com/golang"],
		});
		expect(get(pathOnly.structured, "warnings")).toContain(
			"grok: excludeDomains were applied to the results, since web search cannot take both domain lists",
		);
	});

	// sub2api-providers: `sub2api-grok` routes … (Numeric citation titles); Grok cost is derived from usage ticks.
	it("repairs numeric and URL citation titles, strips citation markers, and reports the cost", async () => {
		const answer =
			"The Go team announced the survey. show render_inline_citation with citation_id is 0  \nMore news.<|eos|>";
		server.route(
			PATH,
			responsesStream(
				[
					customToolCall("x_keyword_search", { query: "from:golang" }),
					message(answer, [
						{ url: "https://x.com/i/status/2103386967853367366", title: "1", start: 0, end: 0 },
						{ url: "https://go.dev/blog/survey2026", title: "https://go.dev/blog/survey2026", start: 0, end: 0 },
					]),
				],
				{ num_server_side_tools_used: 2, cost_in_usd_ticks: 416_865_600 },
			),
		);
		pi = await startGrok();
		const result = await call(pi, "web_search", { query: "go survey", domains: ["x.com"] });
		expect(get(result.structured, "results")).toEqual([
			{ title: "x.com post 2103386967853367366", url: "https://x.com/i/status/2103386967853367366", snippet: "" },
		]);
		expect(get(result.structured, "answer")).toBe("The Go team announced the survey.  \nMore news.");
		expect(get(result.structured, "costUsd")).toBe(0.04168656);
		await call(pi, "web_search", { query: "go survey" });
		const unfiltered = await call(pi, "web_search", { query: "go survey" });
		expect(get(unfiltered.structured, "results", 1)).toEqual({
			title: "go.dev",
			url: "https://go.dev/blog/survey2026",
			snippet: "",
		});
	});

	// sub2api-providers: `sub2api-grok` fetches X posts through `x_search` and other pages through `web_search`.
	it("fetches X posts through x_search, reports missing posts, and opens other pages through web search", async () => {
		const post =
			"**Author handle:** @GoLandIDE  \n**Post date:** Fri, 25 Sep 2026 07:31:46 GMT  \n\nGo 1.27 introduces a portable SIMD package. show render_inline_citation with citation_id is 0";
		server.route(
			PATH,
			responsesStream(
				[
					customToolCall("x_thread_fetch", { post_id: "2103386967853367366" }),
					message(post, [{ url: "https://x.com/i/status/2103386967853367366", title: "1" }]),
				],
				{ num_server_side_tools_used: 1, cost_in_usd_ticks: 249_640_000 },
			),
			responsesStream([customToolCall("x_thread_fetch", { post_id: "1" }), message("I could not find that post.")], {
				num_server_side_tools_used: 0,
			}),
			responsesStream([message("I cannot look that post up.")], { num_server_side_tools_used: 0 }),
			responsesStream([openPageCall("https://go.dev/doc/devel/release"), message("go1.27.3 (released 2026-10-19)")]),
		);
		server.route("/ds/tools/fetch", deepseekPage("Fallback", "fallback text"));
		pi = await startGrok({ enableImageUnderstanding: true });
		const fetched = await call(pi, "web_fetch", { url: POST });
		const first = server.at(PATH)[0]?.body;
		expect(get(first, "tools")).toEqual([{ type: "x_search", enable_image_understanding: true }]);
		expect(get(first, "include")).toBeUndefined();
		expect(String(get(first, "input"))).toContain("2103386967853367366");
		expect(fetched.structured).toMatchObject({ provider: "grok", extraction: "model", costUsd: 0.024964 });
		const content = String(get(fetched.structured, "content"));
		expect(content).toContain("@GoLandIDE");
		expect(content).toContain("25 Sep 2026");
		expect(content).toContain("Go 1.27 introduces a portable SIMD package.");
		expect(content).not.toContain("render_inline_citation");

		const missing = await call(pi, "web_fetch", { url: "https://twitter.com/someone/status/1" });
		expect(get(missing.structured, "attempts", 0)).toMatchObject({
			provider: "grok",
			outcome: "error",
			reason: "post not found",
		});
		const untouched = await call(pi, "web_fetch", { url: "https://x.com/someone/status/2" });
		expect(get(untouched.structured, "attempts", 0)).toMatchObject({
			provider: "grok",
			outcome: "error",
			reason: "post not found",
		});

		const page = await call(pi, "web_fetch", { url: "https://go.dev/doc/devel/release" });
		expect(get(server.at(PATH)[3]?.body, "tools")).toEqual([{ type: "web_search" }]);
		expect(page.structured).toMatchObject({
			provider: "grok",
			content: "go1.27.3 (released 2026-10-19)",
			extraction: "model",
		});
	});
});
