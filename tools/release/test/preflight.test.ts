import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistryDouble } from "./registry.ts";
import { A, seed, TestRepo } from "./repo.ts";

let registry: RegistryDouble;
let repo: TestRepo;
let scratch: string;

beforeAll(async () => {
	registry = await RegistryDouble.start();
});

afterAll(async () => {
	await registry.close();
});

beforeEach(async () => {
	registry.reset();
	repo = await TestRepo.create(registry);
	scratch = await mkdtemp(join(tmpdir(), "release-preflight-"));
	await seed(repo);
});

afterEach(async () => {
	await repo.cleanup();
	await rm(scratch, { recursive: true, force: true });
});

/** A merged change to pi-a with a minor intent, then a release branch prepared by `pnpm version -r`, checked out. */
async function releaseBranch(files: Record<string, string>): Promise<void> {
	await repo.pullRequest("feat(pi-a): change", async () => {
		await repo.commit("feat(pi-a): change", files);
		await repo.change("minor", "A feature", A);
	});
	await repo.git("checkout", "-q", "-b", "release");
	await repo.version();
}

/** `cli.ts preflight` in the checkout of the pull request head, as ci.yml runs it. */
function preflight() {
	return repo.cli("preflight", "--base", "master", "--head", "HEAD", "--work-dir", scratch);
}

describe("cli.ts preflight, the pull request artifact check", { timeout: 60_000 }, () => {
	// package-releases: Preflight preparation artifacts before merge.
	it("fails a preparation whose plugin does not load in Pi, naming it", async () => {
		await releaseBranch({ "packages/pi-a/src/index.ts": 'throw new Error("pi-a cannot start");\n' });
		const result = await preflight();
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(
			/no member of this batch may be uploaded[\s\S]*@zeroclover\/pi-a@0.1.0: Pi could not load/,
		);
	});

	// package-releases: Preflight preparation artifacts before merge, Validate the actual installable package.
	it("fails a preparation whose tarball would ship a Pi host package as a dependency", async () => {
		await releaseBranch(
			repo.plugin("pi-a", {
				version: "0.1.0",
				manifest: { dependencies: { "@earendil-works/pi-coding-agent": "*" } },
			}),
		);
		const result = await preflight();
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(
			/@zeroclover\/pi-a@0.1.0: @earendil-works\/pi-coding-agent is provided by Pi; declare it only in peerDependencies/,
		);
	});

	// package-releases: Preflight preparation artifacts before merge.
	it("packs nothing for a pull request without new release records", async () => {
		await repo.git("checkout", "-q", "-b", "docs");
		await repo.commit("docs: typo", { "README.md": "# typo\n" });
		const result = await preflight();
		expect([result.code, result.stdout]).toEqual([0, "artifact preflight: no new release records; nothing to pack\n"]);
	});
});
