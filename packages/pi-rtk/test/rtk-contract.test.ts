import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RTK_BIN, TIMEOUT_MS } from "../src/controller.ts";
import { interpretRewrite } from "../src/outcome.ts";
import { runFile } from "../src/run.ts";

// Checks the exit-code contract against the rtk on PATH; skipped where rtk is not installed (CI).
const hasRtk = spawnSync(RTK_BIN, ["--version"]).status === 0;

async function rewrite(command: string) {
	return interpretRewrite(command, await runFile(RTK_BIN, ["rewrite", command], { timeoutMs: TIMEOUT_MS }));
}

describe.skipIf(!hasRtk)("rtk rewrite contract", () => {
	it("rewrites a supported command", async () => {
		expect(await rewrite("git status")).toEqual({ kind: "rewrite", command: "rtk git status" });
	});

	it("leaves unsupported and already rewritten commands unchanged", async () => {
		expect(await rewrite("vim notes.txt")).toEqual({ kind: "unchanged" });
		expect(await rewrite("rtk git status")).toEqual({ kind: "unchanged" });
	});
});
