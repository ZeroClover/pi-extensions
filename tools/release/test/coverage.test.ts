import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistryDouble } from "./registry.ts";
import { A, seed, TestRepo } from "./repo.ts";

let registry: RegistryDouble;
let repo: TestRepo;
let base: string;

beforeAll(async () => {
	registry = await RegistryDouble.start();
});

afterAll(async () => {
	await registry.close();
});

beforeEach(async () => {
	registry.reset();
	repo = await TestRepo.create(registry);
	base = await seed(repo);
	await repo.git("checkout", "-q", "-b", "feature");
});

afterEach(async () => {
	await repo.cleanup();
});

function coverage() {
	return repo.cli("coverage", "--base", base, "--head", "HEAD");
}

describe("cli.ts coverage, the pull request release-impact gate", () => {
	// package-releases: PRs declare their own release impact.
	it("fails a plugin change without a release decision and passes once pnpm change records one", async () => {
		await repo.commit("feat(pi-a): change", { "packages/pi-a/src/index.ts": "export default function () {}\n" });
		const missing = await coverage();
		expect(missing.code).toBe(1);
		expect(missing.stdout).toMatch(/error: @zeroclover\/pi-a: published files changed .* no release decision/);

		await repo.change("patch", "Fix the greeting", A);
		const decided = await coverage();
		expect([decided.code, decided.stdout]).toEqual([0, expect.stringMatching(/@zeroclover\/pi-a: patch release/)]);
	});

	// package-releases: PRs declare their own release impact.
	it("accepts a reasoned none decision as the plugin's release decision", async () => {
		await repo.commit("refactor(pi-a): rename", { "packages/pi-a/src/index.ts": "export default function () {}\n" });
		await repo.change("none", "Internal rename; no user-facing change", A);
		const result = await coverage();
		expect([result.code, result.stdout]).toEqual([0, expect.stringMatching(/@zeroclover\/pi-a: no release/)]);
	});

	// package-releases: PRs declare their own release impact.
	it("does not demand a decision for changes that are never published", async () => {
		await repo.commit("test(pi-a): scenario", {
			"packages/pi-a/test/a.test.ts": "export {};\n",
			"packages/pi-a/openspec/specs/a/spec.md": "# Spec\n",
		});
		const result = await coverage();
		expect(result.code, result.output).toBe(0);
		expect(result.stdout).not.toMatch(/error:/);
	});

	// package-releases: Default-branch publication uses the prepared records (versions change only by preparation).
	it("fails a version edited by hand outside a release preparation", async () => {
		await repo.commit("chore(pi-a): bump", {
			...repo.plugin("pi-a", { version: "0.2.0" }),
		});
		await repo.change("minor", "A feature", A);
		const result = await coverage();
		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(/pi-a\/package.json: version 0.1.0 -> 0.2.0 without a release record/);
	});
});
