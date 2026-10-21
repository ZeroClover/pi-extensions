import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCommands } from "../src/artifact.ts";
import { runCommand } from "../src/exec.ts";

/**
 * Every workspace extension loads in the repository's Pi host without a model call, as
 * docs/workflow.md "Verify" requires. Release verification repeats this for packed artifacts.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const PACKAGES = (await readdir(join(ROOT, "packages"), { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

let workDir: string;

beforeAll(async () => {
	workDir = await mkdtemp(join(tmpdir(), "workspace-load-"));
});

afterAll(async () => {
	await rm(workDir, { recursive: true, force: true });
});

describe("workspace extensions", () => {
	it.each(PACKAGES)("packages/%s loads in Pi", { timeout: 60_000 }, async (dirName) => {
		const ctx = { run: runCommand, workDir, hostBin: join(ROOT, "node_modules/.bin/pi") };
		await expect(loadCommands(ctx, join(ROOT, "packages", dirName), workDir)).resolves.toBeInstanceOf(Array);
	});
});
