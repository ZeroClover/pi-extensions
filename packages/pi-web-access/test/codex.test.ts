import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import { deepseekPage, message, openPageCall, responsesStream, webSearchCall } from "./fixtures/backends.ts";
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

const PATH = "/v1/responses";

function startCodex(options: Record<string, unknown> = {}) {
	return startWebAccess({
		models: { gw: piProvider(`${server.url}/v1`, "gpt-test", { key: "gw-key-0123456789" }) },
		config: {
			providers: {
				codex: { type: "sub2api-codex", provider: "gw", model: "gpt-test", ...options },
				ds: { type: "deepseek", baseUrl: `${server.url}/ds` },
			},
			search: ["codex", "ds"],
			fetch: ["codex", "ds"],
		},
		auth: { deepseek: { type: "api_key", key: "ds-key-0123456789" } },
	});
}

describe("sub2api-codex provider", () => {
	// sub2api-providers: `sub2api-codex` searches with the Responses `web_search` tool.
	// provider-routing: Unsupported options degrade with a warning.
	it("sends a required, filtered web_search tool and warns that recency was ignored", async () => {
		server.route(PATH, responsesStream([webSearchCall(["https://github.com/golang/go"]), message("answer")]));
		pi = await startCodex({ userLocation: { country: "US" }, searchContextSize: "low" });
		const result = await call(pi, "web_search", {
			query: "go generics",
			domains: ["github.com"],
			excludeDomains: ["reddit.com"],
			recency: "week",
		});
		expect(server.at(PATH)[0]?.body).toEqual({
			model: "gpt-test",
			instructions: expect.any(String),
			input: "go generics",
			tools: [
				{
					type: "web_search",
					filters: { allowed_domains: ["github.com"], blocked_domains: ["reddit.com"] },
					user_location: { type: "approximate", country: "US" },
					search_context_size: "low",
				},
			],
			tool_choice: "required",
			include: ["web_search_call.action.sources"],
			store: false,
			stream: true,
		});
		expect(get(result.structured, "warnings")).toEqual(["codex: recency was ignored, the provider has no date filter"]);
	});

	// sub2api-providers: Responses search results come from citations and sources; web-search: Unified search result
	// (Provider that produces an answer).
	it("lists cited pages with their passages first, then uncited sources, and returns the answer", async () => {
		const text =
			"Go 1.27.3 is the latest release. ([go.dev](https://go.dev/dl/?utm_source=openai)) It fixes x509. ([go.dev](https://go.dev/doc/devel/release))";
		const firstLink = "([go.dev](https://go.dev/dl/?utm_source=openai))";
		const firstCite = text.indexOf(firstLink);
		const secondCite = text.indexOf("([go.dev](https://go.dev/doc");
		server.route(
			PATH,
			responsesStream([
				webSearchCall(["https://go.dev/dl/", "https://go.dev/doc/devel/release", "https://go.dev/blog/go1.27"]),
				message(text, [
					{
						url: "https://go.dev/dl/?utm_source=openai",
						title: "All releases",
						start: firstCite,
						end: firstCite + firstLink.length,
					},
					{ url: "https://go.dev/doc/devel/release", title: "Release History", start: secondCite, end: text.length },
				]),
			]),
		);
		pi = await startCodex();
		const result = await call(pi, "web_search", { query: "latest go" });
		expect(get(result.structured, "answer")).toBe(text);
		expect(get(result.structured, "results")).toEqual([
			{ title: "All releases", url: "https://go.dev/dl/", snippet: "Go 1.27.3 is the latest release." },
			{ title: "Release History", url: "https://go.dev/doc/devel/release", snippet: "It fixes x509." },
			{ title: "go.dev", url: "https://go.dev/blog/go1.27", snippet: "" },
		]);
		expect(result.text).toContain("Answer: Go 1.27.3 is the latest release.");
	});

	// sub2api-providers: Responses search results come from citations and sources (Model answered without
	// searching); Responses failures are recognised.
	it("fails attempts that did not search, were rejected, or ended badly, and falls through", async () => {
		server.route(
			PATH,
			responsesStream([message("I know this already.")]),
			{ status: 400, json: { error: { message: "Upstream rejected the request", type: "invalid_request_error" } } },
			{
				sse: [
					{ type: "response.created", response: { status: "in_progress" } },
					{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } },
				],
			},
			{ sse: [{ type: "response.created", response: { status: "in_progress" } }] },
			{
				sse: [
					{
						type: "response.completed",
						response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
					},
				],
			},
		);
		server.route("/ds/tools/search", { json: { results: [] } });
		pi = await startCodex();
		const reasons: unknown[] = [];
		for (let n = 0; n < 5; n++)
			reasons.push(get((await call(pi, "web_search", { query: "q" })).structured, "attempts", 0, "reason"));
		expect(reasons).toEqual([
			"no web search performed",
			"400 Upstream rejected the request",
			"response.failed: boom",
			"the stream ended before response.completed",
			"response incomplete: max_output_tokens",
		]);
	});

	// sub2api-providers: Responses search results come from citations and sources, over a stream with CRLF line
	// endings whose event separators fall across network chunks.
	it("reads a CRLF event stream whose separators are split between chunks", async () => {
		const events = [
			{ type: "response.created", response: { status: "in_progress", output: [] } },
			{ type: "response.output_item.done", item: webSearchCall(["https://go.dev/dl/"]) },
			{ type: "response.output_item.done", item: message("Go 1.27.3") },
			{ type: "response.completed", response: { status: "completed", output: [] } },
		];
		const stream = events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
		// Split every event separator before its last LF: one chunk ends in `\r\n\r`, the next starts with `\n`.
		const chunks = stream
			.split("\r\n\r\n")
			.flatMap((part, index, all) => (index < all.length - 1 ? [`${part}\r\n\r`, "\n"] : [part]));
		server.route(PATH, { chunks });
		pi = await startCodex();
		const result = await call(pi, "web_search", { query: "latest go" });
		expect(get(result.structured, "attempts", 0, "outcome")).toBe("ok");
		expect(get(result.structured, "answer")).toBe("Go 1.27.3");
	});

	// sub2api-providers: `sub2api-codex` fetches by opening the page inside `web_search`.
	// web-fetch: The extraction method is labelled (Model-mediated provider).
	it("fetches through an opened page, labels the text as a model's rendition, and rejects unopened pages", async () => {
		const url = "https://go.dev/doc/devel/release";
		server.route(
			PATH,
			responsesStream([openPageCall(url), message("# Release History\n\ngo1.27.3 (released 2026-10-19)")]),
			responsesStream([webSearchCall(["https://example.com/"]), message("Here is a summary instead.")]),
		);
		server.route("/ds/tools/fetch", deepseekPage("Release History", "verbatim text"));
		pi = await startCodex();
		const opened = await call(pi, "web_fetch", { url });
		const body = server.at(PATH)[0]?.body;
		expect(get(body, "tools")).toEqual([{ type: "web_search" }]);
		expect(String(get(body, "input"))).toContain(url);
		expect(opened.structured).toMatchObject({
			provider: "codex",
			content: "# Release History\n\ngo1.27.3 (released 2026-10-19)",
			extraction: "model",
		});
		expect(get(opened.structured, "warnings")).toEqual([
			"codex: the content is a model's rendition of the page and may be incomplete or inexact",
		]);
		// A rendition says nothing about the length of the page itself.
		expect(get(opened.structured, "totalChars")).toBeUndefined();
		const unopened = await call(pi, "web_fetch", { url });
		expect(get(unopened.structured, "attempts")).toMatchObject([
			{ provider: "codex", outcome: "error", reason: "the model did not open the page" },
			{ provider: "ds", outcome: "ok" },
		]);
		expect(get(unopened.structured, "warnings")).toEqual([]);
	});
});
