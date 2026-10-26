import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import {
	citedText,
	deepseekPage,
	fetchResultBlock,
	messagesReply,
	searchResultBlock,
	serverToolUse,
	toolErrorBlock,
} from "./fixtures/backends.ts";
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

const PATH = "/v1/messages";

function startClaude() {
	return startWebAccess({
		// The Claude group's models carry the gateway root without /v1.
		models: {
			gw: {
				baseUrl: server.url,
				apiKey: "claude-key-0123456789",
				api: "anthropic-messages",
				models: [{ id: "claude-test" }],
			},
		},
		config: {
			providers: {
				claude: { type: "sub2api-claude", provider: "gw", model: "claude-test" },
				ds: { type: "deepseek", baseUrl: `${server.url}/ds` },
			},
		},
		auth: { deepseek: { type: "api_key", key: "ds-key-0123456789" } },
	});
}

const RESULTS = Array.from({ length: 10 }, (_, n) => ({
	url: `https://github.com/golang/go/issues/${n}`,
	title: `Issue ${n}`,
}));

describe("sub2api-claude provider", () => {
	// sub2api-providers: `sub2api-claude` searches with `web_search_20250305`; Anthropic search results come from
	// tool-result blocks.
	it("searches with allowed or blocked domains, never both, and maps results with cited passages", async () => {
		server.route(
			PATH,
			messagesReply(
				[
					serverToolUse("srvtoolu_01", "web_search", { query: "go issues" }),
					searchResultBlock("srvtoolu_01", RESULTS),
					citedText("Issue 2 tracks it", [{ url: RESULTS[2]?.url ?? "", title: "Issue 2", cited: "passage two" }]),
					citedText(" and issue 7 too.", [{ url: RESULTS[7]?.url ?? "", title: "Issue 7", cited: "passage seven" }]),
				],
				{ web_search_requests: 1 },
			),
		);
		pi = await startClaude();
		const allowed = await call(pi, "web_search", { query: "go issues", domains: ["github.com"], maxResults: 10 });
		const both = await call(pi, "web_search", {
			query: "go issues",
			domains: ["github.com"],
			excludeDomains: ["gist.github.com"],
		});
		await call(pi, "web_search", { query: "go issues", excludeDomains: ["reddit.com"] });
		const pathOnly = await call(pi, "web_search", {
			query: "go issues",
			domains: ["github.com"],
			excludeDomains: ["github.com/golang/go/issues/1"],
		});
		const [first, second, third] = server.at(PATH);
		expect(first?.headers["x-api-key"]).toBe("claude-key-0123456789");
		expect(first?.headers["anthropic-version"]).toBe("2023-06-01");
		expect(get(first?.body, "tools")).toEqual([
			{ type: "web_search_20250305", name: "web_search", max_uses: 3, allowed_domains: ["github.com"] },
		]);
		expect(get(second?.body, "tools")).toEqual(get(first?.body, "tools"));
		expect(get(third?.body, "tools")).toEqual([
			{ type: "web_search_20250305", name: "web_search", max_uses: 3, blocked_domains: ["reddit.com"] },
		]);
		const results = get(allowed.structured, "results");
		expect(results).toHaveLength(10);
		expect(get(results, 2)).toEqual({ title: "Issue 2", url: RESULTS[2]?.url, snippet: "passage two" });
		expect(get(results, 7, "snippet")).toBe("passage seven");
		expect(get(results, 0, "snippet")).toBe("");
		expect(get(allowed.structured, "answer")).toBe("Issue 2 tracks it and issue 7 too.");
		expect(get(both.structured, "warnings")).toContain(
			"claude: excludeDomains were applied to the results, since the search tool cannot take both domain lists",
		);
		expect(get(server.at(PATH)[3]?.body, "tools")).toEqual(get(first?.body, "tools"));
		expect(get(pathOnly.structured, "warnings")).toContain(
			"claude: excludeDomains were applied to the results, since the search tool cannot take both domain lists",
		);
		const suffixOnly = await call(pi, "web_search", {
			query: "政策",
			domains: [".cn"],
			excludeDomains: ["reddit.com"],
		});
		expect(get(server.at(PATH).at(-1)?.body, "tools")).toEqual([
			{ type: "web_search_20250305", name: "web_search", max_uses: 3 },
		]);
		expect(get(suffixOnly.structured, "warnings")).toContain(
			"claude: excludeDomains were applied to the results, since the search tool cannot take both domain lists",
		);
	});

	// sub2api-providers: Anthropic search results come from tool-result blocks (Search tool error, Gateway emulated
	// the search).
	it("fails on tool errors or no search, and warns when the gateway emulated the search", async () => {
		server.route(
			PATH,
			messagesReply([toolErrorBlock("web_search_tool_result", "srvtoolu_01", "max_uses_exceeded")], {
				web_search_requests: 1,
			}),
			messagesReply([{ type: "text", text: "From memory." }], { web_search_requests: 0 }),
			messagesReply(
				[
					serverToolUse("srvtoolu_ws_01", "web_search", { query: "q" }),
					searchResultBlock("srvtoolu_ws_01", RESULTS.slice(0, 1)),
				],
				{ web_search_requests: 1 },
			),
		);
		server.route("/ds/tools/search", { json: { results: [] } });
		pi = await startClaude();
		const failed = await call(pi, "web_search", { query: "q" });
		expect(get(failed.structured, "attempts", 0, "reason")).toBe("search tool error: max_uses_exceeded");
		const unsearched = await call(pi, "web_search", { query: "q" });
		expect(get(unsearched.structured, "attempts", 0, "reason")).toBe("no web search performed");
		const emulated = await call(pi, "web_search", { query: "q" });
		expect(get(emulated.structured, "provider")).toBe("claude");
		expect(get(emulated.structured, "warnings")).toEqual([
			"claude: the gateway emulated the search; provider-side filters were not applied",
		]);
	});

	// sub2api-providers: `sub2api-claude` fetches live with `web_fetch_20260309`; Anthropic fetch results.
	it("fetches live through the direct web_fetch tool and returns the document text with its retrieval time", async () => {
		const url = "https://go.dev/doc/devel/release";
		server.route(
			PATH,
			messagesReply(
				[
					serverToolUse("srvtoolu_01", "web_fetch", { url }),
					fetchResultBlock("srvtoolu_01", {
						url,
						title: "Release History",
						text: "go1.27.3 (released 2026-10-19)",
						retrievedAt: "2026-10-22T22:15:31+00:00",
					}),
					{ type: "text", text: "done" },
				],
				{ web_fetch_requests: 1 },
			),
			messagesReply(
				[
					serverToolUse("srvtoolu_02", "web_fetch", { url }),
					toolErrorBlock("web_fetch_tool_result", "srvtoolu_02", "url_not_allowed"),
				],
				{ web_fetch_requests: 1 },
			),
		);
		server.route("/ds/tools/fetch", deepseekPage("Post", "post text"));
		pi = await startClaude();
		const page = await call(pi, "web_fetch", { url, maxChars: 20_000 });
		expect(get(server.at(PATH)[0]?.body, "tools")).toEqual([
			{
				type: "web_fetch_20260309",
				name: "web_fetch",
				max_uses: 1,
				allowed_callers: ["direct"],
				use_cache: false,
				allowed_domains: ["go.dev"],
				max_content_tokens: 60_000,
			},
		]);
		expect(page.structured).toMatchObject({
			provider: "claude",
			title: "Release History",
			content: "go1.27.3 (released 2026-10-19)",
			crawledAt: "2026-10-22T22:15:31+00:00",
			extraction: "verbatim",
			truncated: false,
		});
		const refused = await call(pi, "web_fetch", { url: "https://x.com/GoLandIDE/status/2103386967853367366" });
		expect(get(refused.structured, "attempts")).toMatchObject([
			{ provider: "claude", outcome: "error", reason: "fetch tool error: url_not_allowed" },
			{ provider: "ds", outcome: "ok" },
		]);
	});

	// web-fetch: Long pages continue by offset, for a document the fetch tool may have cut at its token budget.
	it("continues a document the token budget may have cut instead of calling it complete", async () => {
		const url = "https://example.com/changelog";
		server.route(PATH, (request) => {
			const budget = Number(get(request.body, "tools", 0, "max_content_tokens"));
			// The worst case of a byte-level tokenizer: three tokens for one character, so the budget yields a third.
			return messagesReply([fetchResultBlock("srvtoolu_01", { url, text: "版".repeat(budget / 3) })], {
				web_fetch_requests: 1,
			});
		});
		pi = await startClaude();
		const first = await call(pi, "web_fetch", { url, maxChars: 1000 });
		expect(get(server.at(PATH)[0]?.body, "tools", 0, "max_content_tokens")).toBe(3000);
		expect(first.structured).toMatchObject({ truncated: true, nextOffset: 1000 });
		expect(get(first.structured, "totalChars")).toBeUndefined();
	});

	// sub2api-providers: `sub2api-claude` does not fetch PDFs.
	it("skips .pdf URLs without a request and fails documents that come back as PDF", async () => {
		const url = "https://arxiv.org/pdf/1706.03762";
		server.route(
			PATH,
			messagesReply([fetchResultBlock("srvtoolu_01", { url, text: "JVBERi0x", mediaType: "application/pdf" })], {
				web_fetch_requests: 1,
			}),
		);
		server.route("/ds/tools/fetch", deepseekPage("Attention", "# Attention Is All You Need"));
		pi = await startClaude();
		const skipped = await call(pi, "web_fetch", { url: `${url}.pdf` });
		expect(get(skipped.structured, "attempts", 0)).toEqual({
			provider: "claude",
			outcome: "skipped",
			reason: "unsupported: pdf",
		});
		expect(server.at(PATH)).toEqual([]);
		const failed = await call(pi, "web_fetch", { url });
		expect(get(failed.structured, "attempts", 0)).toMatchObject({
			provider: "claude",
			outcome: "error",
			reason: "unsupported: pdf",
		});
	});
});
