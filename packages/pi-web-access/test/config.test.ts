import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import { call, notices, startWebAccess } from "./fixtures/session.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

async function command(session: Pi): Promise<string> {
	const before = session.ui.notices.length;
	await session.prompt("/web-access");
	return session.ui.notices
		.slice(before)
		.map((notice) => notice.message)
		.join("\n");
}

describe("configuration", () => {
	// web-access-configuration: Configuration file location; Inspection command (No configuration).
	// web-search / web-fetch: The tool is always registered (No configuration file).
	it("registers both tools without a file, says once where the file belongs, and fails calls naming it", async () => {
		pi = await startWebAccess();
		const path = join(pi.agentDir, "pi-web-access.json");
		expect(pi.ui.notices).toEqual([
			{
				level: "info",
				message: `pi-web-access: ${path} not found; web_search and web_fetch will fail until providers are configured there`,
			},
		]);
		expect(pi.session.getActiveToolNames()).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
		const search = await call(pi, "web_search", { query: "q" });
		expect(search.isError).toBe(true);
		expect(search.text).toBe(`no search provider is configured; add providers to ${path}`);
		const fetch = await call(pi, "web_fetch", { url: "https://example.com/" });
		expect(fetch.isError).toBe(true);
		expect(fetch.text).toBe(`no fetch provider is configured; add providers to ${path}`);
		expect(await command(pi)).toBe(
			`pi-web-access: no provider is configured; expected configuration file: ${path} (the file does not exist)`,
		);
	});

	// web-access-configuration: Validation and fallback; Provider entry schema; Required fields and defaults per
	// provider type; Provider-specific defaults; Configuration schema (Provider name with whitespace).
	it("drops or defaults only the invalid parts of the file, with one warning each", async () => {
		pi = await startWebAccess({
			config: {
				providers: {
					exa: { type: "exa", apiKey: "exa-key-0001", foo: 1 },
					bing: { type: "bing" },
					"my exa": { type: "exa" },
					codex: { type: "sub2api-codex", provider: "zero-aicoding-codex" },
					slow: { type: "deepseek", timeoutMs: 10 },
					picky: { type: "exa", searchType: "neural" },
				},
				search: ["exa", "nope"],
				rules: [
					{ name: "X", sites: ["x.com"], search: ["missing"] },
					{ name: "CN", sites: [], fetch: ["exa"] },
					{ sites: ["x.com"], search: ["exa"] },
					{ name: "Y", sites: ["y.com", 5], search: ["exa"] },
				],
				extra: true,
			},
		});
		const path = join(pi.agentDir, "pi-web-access.json");
		expect(notices(pi, "warning")).toEqual(
			[
				"extra: unknown setting; ignored",
				"providers.exa: foo is unknown for type exa; ignored",
				'providers.bing: unknown type "bing"; expected one of sub2api-search, sub2api-codex, sub2api-claude, sub2api-grok, deepseek, exa; provider ignored',
				"providers.my exa: provider names cannot be empty or contain whitespace; provider ignored",
				"providers.codex: a sub2api-codex provider needs model; provider ignored",
				"providers.slow: timeoutMs must be an integer from 1000 to 600000; using 60000",
				"providers.picky: searchType must be one of lite, auto; provider ignored",
				'search: "nope" is not a configured provider; removed',
				'rules.X.search: "missing" is not a configured provider; removed',
				"rules.X: no configured provider left for search or fetch; rule ignored",
				"rules.CN: sites must be a non-empty array of site patterns; rule ignored",
				"rules[2]: name must be a non-empty string; rule ignored",
				"rules.Y.sites: 5 is not a site pattern; ignored",
			].map((message) => `pi-web-access: ${path}: ${message}`),
		);
		const status = await command(pi);
		expect(status).toContain("search chain: exa\n");
		expect(status).toContain("fetch chain: exa, slow\n");
		expect(status).toContain("timeout 60000 ms");
		expect(status).toContain("Y: y.com -> search: exa");
		await pi.dispose();

		pi = await startWebAccess({ config: "{ not json" });
		expect(notices(pi, "warning")).toEqual([
			expect.stringMatching(/^pi-web-access: .*pi-web-access\.json: invalid JSON \(.+\); no provider is configured$/),
		]);
		expect(await command(pi)).toMatch(
			/no provider is configured; expected configuration file: .*\(it declares no usable provider\)$/,
		);
	});

	// web-access-configuration: Inspection command (Status while idle); Configuration schema (Full file).
	it("shows providers, credential status, chains and rules without printing any key", async () => {
		pi = await startWebAccess({
			config: {
				providers: {
					literal: { type: "exa", apiKey: "exa-literal-key-0001" },
					vault: { type: "exa", apiKey: "!printf vault-key-0002" },
					missing: { type: "exa", apiKey: "$PI_WEB_ACCESS_TEST_UNSET" },
					ds: { type: "deepseek" },
				},
				fetch: ["vault", "literal"],
				rules: [{ name: "X", sites: ["x.com", "twitter.com"], search: ["literal"], fetch: ["vault"] }],
			},
			auth: { deepseek: { type: "api_key", key: "ds-key-0123456789" } },
			env: { PI_WEB_ACCESS_TEST_UNSET: undefined },
		});
		const status = await command(pi);
		expect(status).toMatch(/literal \(exa; key from apiKey\): ready/);
		expect(status).toMatch(/vault \(exa; key from apiKey\): not resolved yet/);
		expect(status).toMatch(
			/missing \(exa; key from apiKey\): failed: no credentials: environment variable PI_WEB_ACCESS_TEST_UNSET is not set/,
		);
		expect(status).toMatch(/ds \(deepseek; Pi provider deepseek\): ready/);
		expect(status).toContain("search (domains hard, recency, content), fetch (verbatim)");
		expect(status).toContain("search chain: literal, vault, missing, ds\n");
		expect(status).toContain("fetch chain: vault, literal\n");
		expect(status).toContain("X: x.com, twitter.com -> search: literal; fetch: vault");
		expect(status).toContain("/reload");
		for (const secret of ["exa-literal-key-0001", "vault-key-0002", "ds-key-0123456789"])
			expect(status).not.toContain(secret);
	});
});
