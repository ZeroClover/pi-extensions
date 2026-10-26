import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import { notices, startWebAccess } from "./fixtures/session.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

/** The JSON block under the README's "Example" heading, as a user would copy it. */
async function readmeExample(): Promise<string> {
	const readme = await readFile(join(import.meta.dirname, "..", "README.md"), "utf8");
	const section = readme.slice(readme.indexOf("### Example"));
	const match = section.match(/```json\n([\s\S]*?)\n```/);
	if (!match?.[1]) throw new Error("the README has no JSON example");
	return match[1];
}

describe("README", () => {
	// web-access-configuration: Configuration schema (Full file); task 6.1: the documented example loads cleanly.
	it("loads the documented example configuration with no warning", async () => {
		pi = await startWebAccess({ config: await readmeExample() });
		expect(notices(pi, "warning")).toEqual([]);
		const before = pi.ui.notices.length;
		await pi.prompt("/web-access");
		const status = pi.ui.notices
			.slice(before)
			.map((notice) => notice.message)
			.join("\n");
		for (const name of ["codex-search", "codex", "claude", "grok", "deepseek", "exa"])
			expect(status).toContain(`  ${name} (`);
		expect(status).toContain("exa (exa; key from apiKey): not resolved yet");
		expect(status).toContain("X: x.com, twitter.com -> search: grok; fetch: grok");
		expect(status).toContain("CN: .cn, zhihu.com -> search: deepseek, codex-search; fetch: deepseek, codex-search");
	});
});
