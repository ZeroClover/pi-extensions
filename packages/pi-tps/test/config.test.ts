import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { type Pi, plainStatus, reply, startPi, tokens } from "../../../tools/e2e/src/index.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

/** The README's example configuration: the fenced block after its `example-config` marker comment. */
async function readmeExample(): Promise<string> {
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	const example = /<!-- example-config[^>]*-->\s*```json\n([\s\S]*?)```/.exec(readme)?.[1];
	if (example === undefined) throw new Error("README.md has no example-config block");
	return example;
}

async function runWith(config: string): Promise<Pi> {
	pi = await startPi({ extensions: ["pi-tps"], mode: "tui", agentFiles: { "pi-tps.json": config } });
	pi.provider.respond(reply(tokens(50, { tokensPerSecond: 200 })));
	await pi.prompt("go");
	return pi;
}

function warnings(session: Pi): string[] {
	return session.ui.notices.filter((notice) => notice.level === "warning").map((notice) => notice.message);
}

describe("configuration", () => {
	// tps-configuration: Validation and fallback.
	it("loads the README's example configuration without warnings", async () => {
		const session = await runWith(await readmeExample());
		expect(warnings(session)).toEqual([]);
		// The example's separator, so the file was read rather than ignored.
		expect(plainStatus(session.ui, "pi-tps").at(-1)).toMatch(/^✓ .* · /);
	});

	// tps-configuration: Validation and fallback.
	it("warns once about an invalid field and still shows the readout", async () => {
		const session = await runWith(JSON.stringify({ separator: 5, baseColor: "muted" }));
		const shown = warnings(session);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("separator");
		expect(plainStatus(session.ui, "pi-tps").at(-1)).toMatch(/^✓ .*TPS \| TTFT/);
	});
});
