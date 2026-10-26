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

function deepseekAt(path: string) {
	return { type: "deepseek", baseUrl: `${server.url}${path}` };
}

function urls(structured: unknown): unknown {
	const results = get(structured, "results");
	return Array.isArray(results) ? results.map((result) => get(result, "url")) : results;
}

describe("site patterns", () => {
	// provider-routing: Site pattern syntax (Suffix pattern, Path pattern); Site rules select the chain.
	it("routes by suffix, host and path patterns on segment boundaries", async () => {
		server.route("/default/tools/search", deepseekResults([]));
		server.route("/cn/tools/search", deepseekResults([]));
		server.route("/default/tools/fetch", deepseekPage("default", "default text"));
		server.route("/golang/tools/fetch", deepseekPage("golang", "golang text"));
		pi = await startWebAccess({
			config: {
				providers: { default: deepseekAt("/default"), cn: deepseekAt("/cn"), golang: deepseekAt("/golang") },
				search: ["default"],
				fetch: ["default"],
				rules: [
					{ name: "CN", sites: [".cn"], search: ["cn"] },
					{ name: "Go org", sites: ["github.com/golang"], fetch: ["golang"] },
				],
			},
			auth: AUTH,
		});
		for (const domain of ["www.gov.cn", "golang.google.cn", "example.com"]) {
			await call(pi, "web_search", { query: "q", domains: [domain] });
		}
		await call(pi, "web_fetch", { url: "https://github.com/golang/go" });
		await call(pi, "web_fetch", { url: "https://github.com/golang-migrate/migrate" });
		await call(pi, "web_fetch", { url: "https://GitHub.com:443/golang" });
		expect(server.requests.map((request) => request.path)).toEqual([
			"/cn/tools/search",
			"/cn/tools/search",
			"/default/tools/search",
			"/golang/tools/fetch",
			"/default/tools/fetch",
			"/golang/tools/fetch",
		]);
	});

	// web-search: Domain filters are enforced client-side; provider-routing: Site pattern syntax (Bare host does not
	// match a lookalike).
	it("keeps only results inside the domain filters, counting what a soft filter let through", async () => {
		server.route("/ds/tools/search", (request) => {
			const query = String(get(request.body, "query"));
			if (query.includes("site:x.com")) {
				return deepseekResults([{ url: "https://codedtx.com/post" }, { url: "https://x.com/golang/status/1" }]);
			}
			if (query.includes("site:github.com")) {
				return deepseekResults([{ url: "https://gist.github.com/a" }, { url: "https://github.com/golang/go" }]);
			}
			return deepseekResults([
				{ url: "https://go.dev/doc/devel/release" },
				{ url: "https://go.dev/blog/go1.27" },
				{ url: "https://go.dev/documentation" },
			]);
		});
		pi = await startWebAccess({ config: { providers: { ds: deepseekAt("/ds") } }, auth: AUTH });
		const x = await call(pi, "web_search", { query: "go", domains: ["x.com"] });
		expect(urls(x.structured)).toEqual(["https://x.com/golang/status/1"]);
		expect(get(x.structured, "warnings")).toEqual(["ds: 1 result outside the domain filters dropped"]);
		const github = await call(pi, "web_search", {
			query: "go",
			domains: ["github.com"],
			excludeDomains: ["gist.github.com"],
		});
		expect(urls(github.structured)).toEqual(["https://github.com/golang/go"]);
		const docs = await call(pi, "web_search", { query: "go", domains: ["go.dev/doc"] });
		expect(urls(docs.structured)).toEqual(["https://go.dev/doc/devel/release"]);
		const subdomain = await call(pi, "web_search", { query: "go", domains: ["https://GitHub.com/"] });
		expect(urls(subdomain.structured)).toEqual(["https://gist.github.com/a", "https://github.com/golang/go"]);
	});

	// provider-routing: Site rules select the chain, with a suffix pattern written as a domain filter.
	it("routes a search restricted to a suffix such as .cn by the rule for that suffix", async () => {
		server.route("/default/tools/search", deepseekResults([]));
		server.route("/cn/tools/search", deepseekResults([{ url: "https://www.gov.cn/a" }]));
		pi = await startWebAccess({
			config: {
				providers: { default: deepseekAt("/default"), cn: deepseekAt("/cn") },
				search: ["default"],
				rules: [{ name: "CN", sites: [".cn"], search: ["cn"] }],
			},
			auth: AUTH,
		});
		await call(pi, "web_search", { query: "政策 site:.cn" });
		await call(pi, "web_search", { query: "政策", domains: [".gov.cn"] });
		expect(server.requests.map((request) => request.path)).toEqual(["/cn/tools/search", "/cn/tools/search"]);
	});

	// provider-routing: Site pattern syntax, with twitter.com and x.com as one site in suffix patterns too.
	it("matches twitter.com and x.com interchangeably, also in suffix patterns", async () => {
		server.route("/default/tools/fetch", deepseekPage("default", "default text"));
		server.route("/x/tools/fetch", deepseekPage("x", "x text"));
		server.route("/x/tools/search", deepseekResults([{ url: "https://mobile.twitter.com/golang" }]));
		pi = await startWebAccess({
			config: {
				providers: { default: deepseekAt("/default"), x: deepseekAt("/x") },
				fetch: ["default"],
				rules: [{ name: "X", sites: [".twitter.com"], search: ["x"], fetch: ["x"] }],
			},
			auth: AUTH,
		});
		for (const url of [
			"https://mobile.twitter.com/golang",
			"https://mobile.x.com/golang",
			"https://twitter.com/golang",
		]) {
			await call(pi, "web_fetch", { url });
		}
		const search = await call(pi, "web_search", { query: "go", domains: [".x.com"] });
		expect(server.requests.map((request) => request.path)).toEqual([
			"/x/tools/fetch",
			"/x/tools/fetch",
			"/default/tools/fetch",
			"/x/tools/search",
		]);
		expect(urls(search.structured)).toEqual(["https://mobile.twitter.com/golang"]);
	});

	// provider-routing: Hosts are compared without case… (One X post under two URLs), for rules and filters alike.
	it("treats the URL forms of one X post as the same site, but not a photo of it", async () => {
		server.route("/default/tools/fetch", deepseekPage("default", "default text"));
		server.route("/post/tools/fetch", deepseekPage("post", "post text"));
		server.route("/default/tools/search", deepseekResults([]));
		server.route(
			"/post/tools/search",
			deepseekResults([{ url: "https://mobile.x.com/i/status/1" }, { url: "https://x.com/golang/status/2" }]),
		);
		pi = await startWebAccess({
			config: {
				providers: { default: deepseekAt("/default"), post: deepseekAt("/post") },
				search: ["default"],
				fetch: ["default"],
				rules: [{ name: "Post", sites: ["x.com/golang/status/1"], search: ["post"], fetch: ["post"] }],
			},
			auth: AUTH,
		});
		for (const url of [
			"https://x.com/i/status/1",
			"https://mobile.x.com/i/web/status/1",
			"https://x.com/i/status/1/photo/2",
		]) {
			await call(pi, "web_fetch", { url });
		}
		const post = await call(pi, "web_search", { query: "go", domains: ["x.com/i/status/1"] });
		const photo = await call(pi, "web_search", {
			query: "go",
			domains: ["x.com/golang/status/1/photo/2"],
			provider: "post",
		});
		expect(server.requests.map((request) => request.path)).toEqual([
			"/post/tools/fetch",
			"/post/tools/fetch",
			"/default/tools/fetch",
			"/post/tools/search",
			"/post/tools/search",
		]);
		expect(urls(post.structured)).toEqual(["https://mobile.x.com/i/status/1"]);
		expect(urls(photo.structured)).toEqual([]);
	});

	// web-search: Domain filters are enforced client-side; provider-routing: Site pattern syntax (path prefixes).
	it("never widens a path exclusion to its whole host, and keeps the case of paths", async () => {
		server.route(
			"/ds/tools/search",
			deepseekResults([{ url: "https://go.dev/doc/install/source" }, { url: "https://go.dev/doc/effective_go" }]),
		);
		server.route("/search", exaSearch([{ url: "https://example.com/Docs/a" }, { url: "https://example.com/docs/b" }]));
		pi = await startWebAccess({
			config: {
				providers: {
					ds: deepseekAt("/ds"),
					exa: { type: "exa", apiKey: "exa-key-0001", baseUrl: server.url },
				},
			},
			auth: AUTH,
		});
		const docs = await call(pi, "web_search", {
			query: "go",
			domains: ["go.dev/doc"],
			excludeDomains: ["go.dev/doc/install", "golang.google.cn"],
			provider: "ds",
		});
		expect(get(server.at("/ds/tools/search")[0]?.body, "query")).toBe("go site:go.dev -site:golang.google.cn");
		expect(urls(docs.structured)).toEqual(["https://go.dev/doc/effective_go"]);
		const cased = await call(pi, "web_search", { query: "docs", domains: ["Example.COM/Docs"], provider: "exa" });
		expect(get(server.at("/search")[0]?.body, "includeDomains")).toEqual(["example.com/Docs"]);
		expect(urls(cased.structured)).toEqual(["https://example.com/Docs/a"]);
	});

	// web-search: Results are deduplicated by normalised URL.
	it("merges results that differ only by tracking parameters, fragment or case of the host", async () => {
		server.route(
			"/search",
			exaSearch([
				{ url: "https://go.dev/dl/?utm_source=openai", title: "first" },
				{ url: "https://go.dev/dl/#1", title: "second" },
				{ url: "https://GO.dev/dl/", title: "third" },
				{ url: "https://go.dev/dl/?mode=json&fbclid=abc", title: "fourth" },
			]),
		);
		pi = await startWebAccess({
			config: { providers: { exa: { type: "exa", apiKey: "exa-key-0001", baseUrl: server.url } } },
		});
		const result = await call(pi, "web_search", { query: "go downloads", maxResults: 2 });
		expect(get(result.structured, "results")).toMatchObject([
			{ url: "https://go.dev/dl/", title: "first" },
			{ url: "https://go.dev/dl/?mode=json", title: "fourth" },
		]);
	});
});
