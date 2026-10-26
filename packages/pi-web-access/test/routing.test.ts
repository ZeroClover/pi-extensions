import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Pi, reply, toolCall, waitFor } from "../../../tools/e2e/src/index.ts";
import { deepseekError, deepseekPage, deepseekResults, exaSearch } from "./fixtures/backends.ts";
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

function deepseekAt(name: string, extra: Record<string, unknown> = {}) {
	return { type: "deepseek", baseUrl: `${server.url}/${name}`, ...extra };
}

/** Which providers the server heard from, in order (the first path segment names the provider). */
function contacted(): string[] {
	return server.requests.map((request) => request.path.split("/")[1] ?? "");
}

describe("routing", () => {
	// provider-routing: Default provider chains (Explicit chain, Omitted chain).
	it("tries the configured chain in order, or every provider in declaration order without one", async () => {
		for (const name of ["a", "b", "c"]) {
			server.route(`/${name}/tools/search`, deepseekError(503, "busy"));
			server.route(`/${name}/tools/fetch`, deepseekError(503, "busy"));
		}
		pi = await startWebAccess({
			config: { providers: { a: deepseekAt("a"), b: deepseekAt("b"), c: deepseekAt("c") }, search: ["c", "a"] },
			auth: AUTH,
		});
		await call(pi, "web_search", { query: "q" });
		expect(contacted()).toEqual(["c", "a"]);
		server.requests.length = 0;
		await call(pi, "web_fetch", { url: "https://example.com/" });
		expect(contacted()).toEqual(["a", "b", "c"]);
	});

	// provider-routing: Site rules select the chain.
	it("lets the first matching rule pick the chain, and applies no rule to unfiltered searches", async () => {
		for (const name of ["web", "grok", "cn", "first", "second"]) {
			server.route(`/${name}/tools/search`, deepseekResults([{ url: "https://x.com/golang/status/1" }]));
			server.route(`/${name}/tools/fetch`, deepseekError(404, "failed to fetch URL"));
		}
		pi = await startWebAccess({
			config: {
				providers: {
					web: deepseekAt("web"),
					grok: deepseekAt("grok"),
					cn: deepseekAt("cn"),
					first: deepseekAt("first"),
					second: deepseekAt("second"),
				},
				search: ["web"],
				fetch: ["web"],
				rules: [
					{ name: "X", sites: ["x.com", "twitter.com"], search: ["grok"] },
					{ name: "CN", sites: [".cn"], fetch: ["cn", "web"] },
					{ name: "Docs A", sites: ["docs.example.com"], search: ["first"] },
					{ name: "Docs B", sites: ["example.com"], search: ["second"] },
				],
			},
			auth: AUTH,
		});
		const steps: [string, () => Promise<unknown>, string[]][] = [
			["X", () => call(pi as Pi, "web_search", { query: "go", domains: ["x.com/golang"] }), ["grok"]],
			["CN", () => call(pi as Pi, "web_fetch", { url: "https://www.gov.cn/" }), ["cn", "web"]],
			["none", () => call(pi as Pi, "web_search", { query: "go" }), ["web"]],
			["first wins", () => call(pi as Pi, "web_search", { query: "go", domains: ["docs.example.com"] }), ["first"]],
		];
		for (const [, run, expected] of steps) {
			server.requests.length = 0;
			await run();
			expect(contacted()).toEqual(expected);
		}
	});

	// provider-routing: Site rules select the chain (a matching rule without a chain for the capability).
	it("keeps the default chain when the first matching rule has no chain for the capability", async () => {
		for (const name of ["web", "grok", "docs"])
			server.route(`/${name}/tools/fetch`, deepseekPage(name, `${name} text`));
		pi = await startWebAccess({
			config: {
				providers: { web: deepseekAt("web"), grok: deepseekAt("grok"), docs: deepseekAt("docs") },
				fetch: ["web"],
				rules: [
					{ name: "X", sites: ["x.com"], search: ["grok"] },
					{ name: "Docs", sites: ["docs.x.com"], fetch: ["docs"] },
				],
			},
			auth: AUTH,
		});
		const result = await call(pi, "web_fetch", { url: "https://docs.x.com/page" });
		expect(get(result.structured, "provider")).toBe("web");
		expect(contacted()).toEqual(["web"]);
	});

	// provider-routing: Per-call provider override.
	it("uses only the named provider, ignoring rules and fallback", async () => {
		server.route("/exa/search", exaSearch([{ url: "https://reddit.com/r/go/1" }]));
		server.route("/ds/tools/search", deepseekResults([]));
		server.route("/down/tools/search", deepseekError(503, "maintenance"));
		pi = await startWebAccess({
			config: {
				providers: {
					down: deepseekAt("down"),
					ds: deepseekAt("ds"),
					exa: { type: "exa", apiKey: "exa-key-0123456789", baseUrl: `${server.url}/exa` },
				},
				rules: [{ name: "Reddit", sites: ["reddit.com"], search: ["ds"] }],
			},
			auth: AUTH,
		});
		const exa = await call(pi, "web_search", { query: "go", domains: ["reddit.com"], provider: "exa" });
		expect(contacted()).toEqual(["exa"]);
		expect(get(exa.structured, "provider")).toBe("exa");
		server.requests.length = 0;
		const down = await call(pi, "web_search", { query: "go", provider: "down" });
		expect(down.isError).toBe(true);
		expect(down.text).toBe("web_search: provider down failed: 503 server error: maintenance (request_id: 0000)");
		expect(contacted()).toEqual(["down"]);
		const unknown = await call(pi, "web_fetch", { url: "https://example.com/", provider: "bing" });
		expect(unknown.text).toBe('unknown provider "bing"; configured providers: down, ds, exa');
	});

	// provider-routing: Fallback on failure; The routing trace is part of every result.
	it("falls through failures and skipped providers, and lists every reason when all fail", async () => {
		server.route("/down/tools/search", deepseekError(503, "busy"));
		server.route("/up/tools/search", deepseekResults([{ url: "https://example.com/a" }]));
		server.route("/down/tools/fetch", deepseekError(503, "busy"));
		server.route("/up/tools/fetch", deepseekError(404, "failed to fetch URL"));
		pi = await startWebAccess({
			config: {
				providers: {
					nokey: { type: "exa", apiKey: "$PI_WEB_ACCESS_NO_KEY", baseUrl: `${server.url}/nokey` },
					down: deepseekAt("down"),
					up: deepseekAt("up"),
				},
			},
			auth: AUTH,
			env: { PI_WEB_ACCESS_NO_KEY: undefined },
		});
		const search = await call(pi, "web_search", { query: "q" });
		expect(get(search.structured, "provider")).toBe("up");
		expect(get(search.structured, "attempts")).toEqual([
			{
				provider: "nokey",
				outcome: "skipped",
				reason: "no credentials: environment variable PI_WEB_ACCESS_NO_KEY is not set",
			},
			{
				provider: "down",
				outcome: "error",
				reason: "503 server error: busy (request_id: 0000)",
				latencyMs: expect.any(Number),
			},
			{ provider: "up", outcome: "ok", latencyMs: expect.any(Number) },
		]);
		expect(search.updates).toEqual([
			"nokey failed (no credentials: environment variable PI_WEB_ACCESS_NO_KEY is not set); trying down",
			"down failed (503 server error: busy (request_id: 0000)); trying up",
		]);
		expect(contacted()).toEqual(["down", "up"]);
		const fetch = await call(pi, "web_fetch", { url: "https://example.com/" });
		expect(fetch.isError).toBe(true);
		expect(fetch.text).toBe(
			[
				"web_fetch: every provider failed:",
				"nokey: skipped (no credentials: environment variable PI_WEB_ACCESS_NO_KEY is not set)",
				"down: error (503 server error: busy (request_id: 0000))",
				"up: error (404 failed to fetch URL (request_id: 0000))",
			].join("\n"),
		);
	});

	// provider-routing: Empty search results.
	it("moves on when a domain-restricted search comes back empty, but accepts an empty unrestricted one", async () => {
		server.route("/a/tools/search", deepseekResults([]));
		server.route("/b/tools/search", (request) =>
			String(get(request.body, "query")).includes("site:reddit.com")
				? deepseekResults([1, 2, 3].map((n) => ({ url: `https://reddit.com/r/go/${n}` })))
				: deepseekResults([]),
		);
		pi = await startWebAccess({ config: { providers: { a: deepseekAt("a"), b: deepseekAt("b") } }, auth: AUTH });
		const reddit = await call(pi, "web_search", { query: "go", domains: ["reddit.com"] });
		expect(get(reddit.structured, "provider")).toBe("b");
		expect(get(reddit.structured, "attempts")).toMatchObject([
			{ provider: "a", outcome: "empty" },
			{ provider: "b", outcome: "ok" },
		]);
		expect(get(reddit.structured, "results")).toHaveLength(3);
		const nowhere = await call(pi, "web_search", { query: "go", domains: ["example.invalid"] });
		expect(nowhere.isError).toBe(false);
		expect(get(nowhere.structured, "results")).toEqual([]);
		expect(get(nowhere.structured, "attempts")).toMatchObject([
			{ provider: "a", outcome: "empty" },
			{ provider: "b", outcome: "empty" },
		]);
		server.requests.length = 0;
		const plain = await call(pi, "web_search", { query: "nothing matches this" });
		expect(get(plain.structured, "results")).toEqual([]);
		expect(get(plain.structured, "attempts")).toMatchObject([{ provider: "a", outcome: "ok" }]);
		expect(contacted()).toEqual(["a"]);
	});

	// provider-routing: Timeouts and cancellation (Slow provider).
	it("records a provider that exceeds its timeout and tries the next one", async () => {
		server.route("/slow/tools/fetch", { ...deepseekPage("late", "late text"), delayMs: 3000 });
		server.route("/fast/tools/fetch", deepseekPage("Fast", "fast text"));
		pi = await startWebAccess({
			config: { providers: { slow: deepseekAt("slow", { timeoutMs: 1000 }), fast: deepseekAt("fast") } },
			auth: AUTH,
		});
		const started = performance.now();
		const result = await call(pi, "web_fetch", { url: "https://example.com/" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(1000);
		expect(get(result.structured, "attempts")).toMatchObject([
			{ provider: "slow", outcome: "error", reason: "timeout after 1000 ms" },
			{ provider: "fast", outcome: "ok" },
		]);
		expect(server.at("/slow/tools/fetch")[0]?.closedEarly).toBe(true);
	});

	// provider-routing: Timeouts and cancellation (User interrupts).
	it("cancels the request in flight and contacts no other provider when the user aborts", async () => {
		server.route("/hang/tools/search", { hang: true });
		server.route("/next/tools/search", deepseekResults([{ url: "https://example.com/a" }]));
		pi = await startWebAccess({
			config: { providers: { hang: deepseekAt("hang"), next: deepseekAt("next") } },
			auth: AUTH,
		});
		const session = pi;
		session.provider.respond(reply(toolCall("web_search", { query: "q" })));
		const run = session.prompt("search");
		await waitFor("the search request", () => server.requests.length > 0);
		const aborting = session.session.abort();
		// Cancellation is prompt: the connection closes well before any timeout would end it.
		await waitFor("the connection to close", () => server.requests[0]?.closedEarly === true, 2000);
		await aborting;
		await run;
		expect(contacted()).toEqual(["hang"]);
		expect(session.toolResults().at(-1)).toMatch(/abort/i);
	});
});
