import { getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type Pi, reply, text, toolCall } from "../../../tools/e2e/src/index.ts";
import { deepseekResults } from "./fixtures/backends.ts";
import { startServer } from "./fixtures/server.ts";
import { CODEMODE, CODEMODE_UNLISTED, PACKAGE, startWebAccess } from "./fixtures/session.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

/** The tools declared in the first request the model received. */
async function declaredTools(session: Pi) {
	session.provider.respond(reply(text("ok")));
	await session.prompt("hello");
	const request = session.provider.requests[0];
	if (!request) throw new Error("the model received no request");
	return getCurrentTools(request.context.messages);
}

/** One tool's section of the codemode description: from its `### \`name\`` heading to the next heading. */
function declarationIn(description: string, name: string): string {
	const start = description.indexOf(`### \`${name}\``);
	if (start < 0) throw new Error(`${name} is not declared in the codemode description`);
	const next = description.indexOf("\n### ", start + 1);
	return description.slice(start, next < 0 ? undefined : next);
}

describe("tool declarations", () => {
	// web-search: The search declaration stays small.
	it("keeps both tools' descriptions and parameter schemas within 4000 characters", async () => {
		pi = await startWebAccess();
		const tools = (await declaredTools(pi)).filter((tool) => tool.name === "web_search" || tool.name === "web_fetch");
		expect(tools.map((tool) => tool.name).sort()).toEqual(["web_fetch", "web_search"]);
		const size = tools.reduce((sum, tool) => sum + tool.description.length + JSON.stringify(tool.parameters).length, 0);
		expect(size).toBeLessThanOrEqual(4000);
	});

	// web-search: The codemode declaration stays small.
	it("keeps both declarations inside the codemode description within 5000 characters", async () => {
		pi = await startWebAccess({ extensions: [PACKAGE, CODEMODE], tools: ["codemode", "web_search", "web_fetch"] });
		const tools = await declaredTools(pi);
		expect(tools.map((tool) => tool.name)).toEqual(["codemode"]);
		const description = tools[0]?.description ?? "";
		const search = declarationIn(description, "web_search");
		const fetch = declarationIn(description, "web_fetch");
		expect(search.length + fetch.length).toBeLessThanOrEqual(5000);
		// The result types come from outputSchema, so scripts receive the structured results.
		expect(search).toContain("attempts: Array<");
		expect(fetch).toContain("nextOffset?: number");
	});

	// design goal: both tools work inside codemode scripts, which receive structuredContent.
	it("gives codemode scripts the structured search result", async () => {
		const server = await startServer();
		try {
			server.route(
				"/ds/tools/search",
				deepseekResults([{ url: "https://example.com/a" }, { url: "https://example.com/b" }]),
			);
			pi = await startWebAccess({
				extensions: [PACKAGE, CODEMODE],
				tools: ["codemode", "web_search", "web_fetch"],
				config: { providers: { ds: { type: "deepseek", baseUrl: `${server.url}/ds` } } },
				auth: { deepseek: { type: "api_key", key: "ds-key-0123456789" } },
			});
			const code =
				'const r = await tools.web_search({ query: "q" });\nreturn { provider: r.provider, urls: r.results.map((x) => x.url) };';
			pi.provider.respond(reply(toolCall("codemode", { code })), reply(text("done")));
			await pi.prompt("search in a script");
			expect(pi.toolResults()[0]).toContain(
				'{"provider":"ds","urls":["https://example.com/a","https://example.com/b"]}',
			);
		} finally {
			await server.close();
		}
	});

	// design goal: both tools work inside codemode scripts, also when the inline budget leaves them unlisted.
	it("lets a codemode script find and call both tools by search when the description lists none", async () => {
		const server = await startServer();
		try {
			server.route("/ds/tools/search", deepseekResults([{ url: "https://example.com/a" }]));
			pi = await startWebAccess({
				extensions: [PACKAGE, CODEMODE_UNLISTED],
				tools: ["codemode", "web_search", "web_fetch"],
				config: { providers: { ds: { type: "deepseek", baseUrl: `${server.url}/ds` } } },
				auth: { deepseek: { type: "api_key", key: "ds-key-0123456789" } },
			});
			const code = [
				'const search = (await searchTools("search the web"))[0]?.name;',
				'const fetch = (await searchTools("read a web page"))[0]?.name;',
				"const declaration = await describeTool(search);",
				'const result = await tools[search]({ query: "q" });',
				'return { search, fetch, declared: declaration.includes("query: string"), urls: result.results.map((r) => r.url) };',
			].join("\n");
			pi.provider.respond(reply(toolCall("codemode", { code })), reply(text("done")));
			await pi.prompt("search in a script");
			const description = getCurrentTools(pi.provider.requests[0]?.context.messages ?? [])[0]?.description ?? "";
			expect(description).not.toContain("web_search");
			expect(description).toContain("searchTools");
			expect(pi.toolResults()[0]).toContain(
				'{"search":"web_search","fetch":"web_fetch","declared":true,"urls":["https://example.com/a"]}',
			);
		} finally {
			await server.close();
		}
	});
});
