import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Pi, reply, type TempBin, tempBin, toolCall, waitFor } from "../../../tools/e2e/src/index.ts";
import { alphaSearch, exaSearch, message, responsesStream, webSearchCall } from "./fixtures/backends.ts";
import { type FixtureServer, startServer } from "./fixtures/server.ts";
import { call, get, piProvider, startWebAccess } from "./fixtures/session.ts";

let pi: Pi | undefined;
let server: FixtureServer;
let bin: TempBin;

beforeEach(async () => {
	server = await startServer();
	bin = await tempBin();
});

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
	await server.close();
	await bin.remove();
});

async function command(session: Pi): Promise<string> {
	const before = session.ui.notices.length;
	await session.prompt("/web-access");
	return session.ui.notices
		.slice(before)
		.map((notice) => notice.message)
		.join("\n");
}

describe("credentials", () => {
	// web-access-configuration: Key expression syntax (Key from a command, Command fails).
	it("runs a key command once per session and reports a failing command with its error", async () => {
		const counter = join(bin.dir, "runs");
		await bin.write("vault-key", `#!/bin/sh\necho run >> '${counter}'\nprintf 'cmd-key-0123456789\\n'\n`);
		await bin.write("locked-vault", "#!/bin/sh\necho 'vault is locked' >&2\nexit 3\n");
		server.route("/search", exaSearch([{ url: "https://example.com/a" }]));
		pi = await startWebAccess({
			config: {
				providers: {
					locked: { type: "exa", apiKey: "!locked-vault", baseUrl: server.url },
					vault: { type: "exa", apiKey: "!vault-key", baseUrl: server.url },
				},
			},
			env: { PATH: bin.path() },
		});
		const first = await call(pi, "web_search", { query: "q" });
		await call(pi, "web_search", { query: "q" });
		expect(server.at("/search").map((request) => request.headers["x-api-key"])).toEqual([
			"cmd-key-0123456789",
			"cmd-key-0123456789",
		]);
		expect((await readFile(counter, "utf8")).trim().split("\n")).toEqual(["run"]);
		expect(get(first.structured, "attempts", 0)).toEqual({
			provider: "locked",
			outcome: "skipped",
			reason: "key command `locked-vault` failed: vault is locked",
		});
		const status = await command(pi);
		expect(status).toContain(
			"locked (exa; key from apiKey): failed: key command `locked-vault` failed: vault is locked",
		);
		expect(status).toContain("vault (exa; key from apiKey): ready");
		expect(status).not.toContain("cmd-key-0123456789");
	});

	// provider-routing: Timeouts and cancellation; a key command is part of the attempt it serves.
	it("bounds a slow key command by the provider's timeout and moves on", async () => {
		server.route("/search", exaSearch([{ url: "https://example.com/a" }]));
		pi = await startWebAccess({
			config: {
				providers: {
					slow: { type: "exa", apiKey: "!sleep 4; printf slow-key-0123456789", baseUrl: server.url, timeoutMs: 1000 },
					fast: { type: "exa", apiKey: "fast-key-0123456789", baseUrl: server.url },
				},
			},
		});
		const started = performance.now();
		const result = await call(pi, "web_search", { query: "q" });
		expect(performance.now() - started).toBeLessThan(3000);
		expect(get(result.structured, "attempts")).toMatchObject([
			{ provider: "slow", outcome: "error", reason: "timeout after 1000 ms" },
			{ provider: "fast", outcome: "ok" },
		]);
		expect(server.at("/search").map((request) => request.headers["x-api-key"])).toEqual(["fast-key-0123456789"]);
	});

	// web-access-configuration: Key expression syntax (Key command times out).
	it("reports a key command that outlived the provider's timeout as timed out, and runs it again next time", async () => {
		const counter = join(bin.dir, "slow-runs");
		const pids = join(bin.dir, "slow-pids");
		// The command starts a child of its own, as a password manager's helper would.
		await bin.write(
			"slow-vault",
			`#!/bin/sh\necho run >> '${counter}'\nsleep 30 &\necho $! >> '${pids}'\nwait\nprintf 'slow-key-0123456789'\n`,
		);
		server.route("/search", exaSearch([]));
		pi = await startWebAccess({
			config: { providers: { slow: { type: "exa", apiKey: "!slow-vault", baseUrl: server.url, timeoutMs: 1000 } } },
			env: { PATH: bin.path() },
		});
		const first = await call(pi, "web_search", { query: "q" });
		expect(first.text).toBe("web_search: provider slow failed: timeout after 1000 ms");
		// The attempt and the command end at the same deadline; the command's exit may be reported a moment later.
		const timedOut = "slow (exa; key from apiKey): failed: key command `slow-vault` timed out after 1000 ms";
		let status = await command(pi);
		for (const started = performance.now(); !status.includes(timedOut) && performance.now() - started < 3000; ) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			status = await command(pi);
		}
		expect(status).toContain(timedOut);
		// The timeout ended the command together with the process it started.
		const [child] = (await readFile(pids, "utf8")).trim().split("\n").map(Number);
		await waitFor(
			"the command's child to exit",
			() => {
				try {
					process.kill(child ?? 0, 0);
					return false;
				} catch {
					return true;
				}
			},
			1500,
		);
		await call(pi, "web_search", { query: "q" });
		expect((await readFile(counter, "utf8")).trim().split("\n")).toEqual(["run", "run"]);
		expect(server.requests).toEqual([]);
	});

	// provider-routing: Timeouts and cancellation; a key command left running by an aborted call does not cut the
	// next call's own timeout short.
	it("gives a call after an abort its full timeout instead of the old command's remaining time", async () => {
		const counter = join(bin.dir, "stuck-runs");
		await bin.write("stuck-vault", `#!/bin/sh\necho run >> '${counter}'\nsleep 4\n`);
		pi = await startWebAccess({
			config: { providers: { stuck: { type: "exa", apiKey: "!stuck-vault", baseUrl: server.url, timeoutMs: 2000 } } },
			env: { PATH: bin.path() },
		});
		const session = pi;
		session.provider.respond(reply(toolCall("web_search", { query: "q" })));
		const aborted = session.prompt("search");
		await waitFor("the key command to start", () => existsSync(counter));
		// Escape ends the wait for the key at once, well before the provider's 2 s timeout.
		const abortedAt = performance.now();
		await session.session.abort();
		await aborted;
		expect(performance.now() - abortedAt).toBeLessThan(1000);
		const started = performance.now();
		const result = await call(session, "web_search", { query: "q" });
		expect(performance.now() - started).toBeGreaterThanOrEqual(2000);
		expect(result.text).toBe("web_search: provider stuck failed: timeout after 2000 ms");
		expect((await readFile(counter, "utf8")).trim().split("\n")).toEqual(["run", "run"]);
	});

	// web-access-configuration: Key expression syntax (Literal key, Environment variable).
	it("reads keys from environment variables and literals, honouring $$ and $! escapes", async () => {
		server.route("/search", exaSearch([]));
		pi = await startWebAccess({
			config: {
				providers: {
					unset: { type: "exa", apiKey: "$PI_WEB_ACCESS_UNSET_KEY", baseUrl: server.url },
					// biome-ignore lint/suspicious/noTemplateCurlyInString: `${NAME}` is the key-expression syntax under test, not a template.
					env: { type: "exa", apiKey: "${PI_WEB_ACCESS_TEST_KEY}", baseUrl: server.url },
					dollar: { type: "exa", apiKey: "$$literal-key", baseUrl: server.url },
					bang: { type: "exa", apiKey: "$!bang-key", baseUrl: server.url },
				},
			},
			env: { PI_WEB_ACCESS_TEST_KEY: "env-key-0123456789", PI_WEB_ACCESS_UNSET_KEY: undefined },
		});
		const result = await call(pi, "web_search", { query: "q", provider: "unset" });
		expect(result.text).toBe(
			"web_search: provider unset failed: no credentials: environment variable PI_WEB_ACCESS_UNSET_KEY is not set",
		);
		for (const provider of ["env", "dollar", "bang"]) await call(pi, "web_search", { query: "q", provider });
		expect(server.at("/search").map((request) => request.headers["x-api-key"])).toEqual([
			"env-key-0123456789",
			"$literal-key",
			"!bang-key",
		]);
	});

	// web-access-configuration: Credential sources (Pi provider credentials, Explicit key wins).
	// sub2api-providers: Sub2API credentials and endpoints come from Pi's provider.
	it("reuses a Pi provider's key, model headers and base URL, unless the entry has its own key", async () => {
		server.route("/v1/alpha/search", alphaSearch([{ url: "https://go.dev/dl/" }]));
		server.route("/v1/responses", responsesStream([webSearchCall(["https://go.dev/dl/"]), message("Go 1.27.3")]));
		pi = await startWebAccess({
			models: {
				gw: piProvider(`${server.url}/v1`, "gpt-test", { key: "gw-key-0123456789", headers: { "X-Extra": "1" } }),
			},
			config: {
				providers: {
					search: { type: "sub2api-search", provider: "gw", model: "gpt-test" },
					codex: { type: "sub2api-codex", provider: "gw", model: "gpt-test" },
					own: { type: "sub2api-search", provider: "gw", model: "gpt-test", apiKey: "own-key-0123456789" },
				},
			},
		});
		for (const provider of ["search", "codex", "own"]) await call(pi, "web_search", { query: "go", provider });
		const seen = server.requests.map(({ path, headers: { authorization, "x-extra": extra, originator } }) => ({
			path,
			authorization,
			extra,
			originator,
		}));
		expect(seen).toEqual([
			{ path: "/v1/alpha/search", authorization: "Bearer gw-key-0123456789", extra: "1", originator: "codex_cli_rs" },
			{ path: "/v1/responses", authorization: "Bearer gw-key-0123456789", extra: "1", originator: undefined },
			{
				path: "/v1/alpha/search",
				authorization: "Bearer own-key-0123456789",
				extra: undefined,
				originator: "codex_cli_rs",
			},
		]);
	});

	// sub2api-providers: Sub2API credentials and endpoints come from Pi's provider (Pi provider missing).
	// provider-routing: Fallback on failure (Provider without credentials).
	it("skips a provider whose Pi provider does not exist, without sending a request", async () => {
		server.route("/search", exaSearch([{ url: "https://example.com/a" }]));
		pi = await startWebAccess({
			config: {
				providers: {
					gone: { type: "sub2api-search", provider: "nope", model: "gpt-test" },
					exa: { type: "exa", apiKey: "exa-key-0123456789", baseUrl: server.url },
				},
			},
		});
		const result = await call(pi, "web_search", { query: "q" });
		expect(get(result.structured, "attempts")).toEqual([
			{ provider: "gone", outcome: "skipped", reason: 'Pi provider "nope" not found' },
			{ provider: "exa", outcome: "ok", latencyMs: expect.any(Number) },
		]);
		expect(server.requests.map((request) => request.path)).toEqual(["/search"]);
	});

	// Design risk "Credential leakage through error text": keys never reach the model.
	it("redacts the key when a backend echoes it in an error", async () => {
		server.route("/search", {
			status: 401,
			json: { error: "Invalid API key exa-key-0123456789", tag: "INVALID_API_KEY" },
		});
		pi = await startWebAccess({
			config: { providers: { exa: { type: "exa", apiKey: "exa-key-0123456789", baseUrl: server.url } } },
		});
		const result = await call(pi, "web_search", { query: "q" });
		expect(result.text).toBe(
			"web_search: provider exa failed: 401 key rejected or missing: Invalid API key <redacted>",
		);
	});
});
