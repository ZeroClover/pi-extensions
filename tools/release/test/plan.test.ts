import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistryDouble } from "./registry.ts";
import { A, B, features, GITHUB_REPO, seed, TestRepo } from "./repo.ts";

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
	scratch = await mkdtemp(join(tmpdir(), "release-plan-"));
	await seed(repo);
});

afterEach(async () => {
	await repo.cleanup();
	await rm(scratch, { recursive: true, force: true });
});

/** `cli.ts plan --event push` as release.yml runs it, with its GITHUB_OUTPUT. */
async function planPush(before: string, after: string, forced = false) {
	const output = join(scratch, `output-${after.slice(0, 8)}-${forced}`);
	const result = await repo.cliWith(
		{ GITHUB_OUTPUT: output },
		"plan",
		"--event",
		"push",
		"--before",
		before,
		"--after",
		after,
		"--forced",
		String(forced),
		"--repo",
		GITHUB_REPO,
		"--default-branch",
		"master",
		"--registry",
		registry.url,
	);
	const outputs = await readFile(output, "utf8").catch(() => "");
	return { ...result, outputs };
}

/** The preparation pull request: real `pnpm version -r`, landed as a squash commit of a merged pull request. */
function prepare(...filter: string[]): Promise<string> {
	return repo.pullRequest("chore(release): prepare", () => repo.version(undefined, ...filter));
}

describe("cli.ts plan --event push, the publication boundary", () => {
	// package-releases: Default-branch publication uses the prepared records. agent-release-workflow: A reviewed merge is the publication boundary.
	it("publishes exactly the records a merged preparation pull request adds, and nothing for a docs-only push", async () => {
		const parent = await features(repo);
		const source = await prepare();
		const plan = await planPush(parent, source);
		expect(plan.code, plan.output).toBe(0);
		expect(plan.stdout).toBe(
			`release batch of ${source} (first parent ${parent}, pull request #2):\n  ${A}@0.1.0\n  ${B}@2.1.3\n`,
		);
		expect(plan.outputs).toBe(`publish=true\nsource_sha=${source}\n`);

		const docs = await repo.pullRequest("docs: typo", () => repo.commit("docs: typo", { "README.md": "# typo\n" }));
		const noop = await planPush(source, docs);
		expect([noop.code, noop.stdout]).toEqual([
			0,
			"release no-op: release records are identical at both push endpoints\n",
		]);
		expect(noop.outputs).toBe("publish=false\nsource_sha=\n");
	});

	// agent-release-workflow: Preparation uses a constrained PR integration protocol, A reviewed merge is the publication boundary.
	it("refuses records that did not pass a reviewed pull request: a forced push or a direct push", async () => {
		const parent = await features(repo);
		const source = await prepare();
		const forced = await planPush(parent, source, true);
		expect(forced.code).toBe(1);
		expect(forced.stderr).toMatch(/unsupported publication boundary[\s\S]*the push was forced/);
		expect(forced.outputs).toBe("");

		await repo.git("reset", "-q", "--hard", parent);
		const direct = await repo.version("chore(release): direct push");
		const unreviewed = await planPush(parent, direct);
		expect(unreviewed.code).toBe(1);
		expect(unreviewed.stderr).toMatch(/is not the squash or merge commit of a pull request merged into master/);
	});

	// package-releases: Default-branch publication uses the prepared records, Preparation must not stack unpublished versions.
	it("refuses a preparation that also changes another plugin's version by hand", async () => {
		const parent = await features(repo);
		const source = await repo.pullRequest("chore(release): prepare pi-b", async () => {
			await repo.version("chore(release): prepare pi-b", B);
			await repo.commit("chore(pi-a): bump by hand", repo.plugin("pi-a", { version: "0.2.0" }));
		});
		const plan = await planPush(parent, source);
		expect(plan.code).toBe(1);
		expect(plan.stderr).toMatch(/pi-a\/package.json: version 0.1.0 -> 0.2.0 without a release record/);
	});

	// agent-release-workflow: A reviewed merge is the publication boundary.
	it("refuses a preparation hidden behind a later integration of the same push", async () => {
		const parent = await features(repo);
		await prepare();
		const docs = await repo.pullRequest("docs: later", () => repo.commit("docs: later", { "README.md": "# later\n" }));
		const plan = await planPush(parent, docs);
		expect(plan.code).toBe(1);
		expect(plan.stderr).toMatch(/unsupported publication boundary[\s\S]*more than one integration/);
	});
});

describe("withdrawal of a preparation", () => {
	/** A pushed preparation and its merged revert. */
	async function withdrawn(): Promise<{ source: string; withdrawal: string }> {
		await features(repo);
		const source = await prepare();
		await repo.push();
		const withdrawal = await repo.pullRequest("revert: withdraw the preparation", () =>
			repo.git("revert", "--no-edit", source),
		);
		return { source, withdrawal };
	}

	// package-releases: Withdraw a failed preparation only before uploads.
	it("accepts the revert of an unpublished preparation and refuses it once a version is on the registry", async () => {
		const { source, withdrawal } = await withdrawn();
		const accepted = await planPush(source, withdrawal);
		expect([accepted.code, accepted.stdout]).toEqual([
			0,
			`release no-op: withdrawal of unpublished ${A}@0.1.0, ${B}@2.1.3; nothing to publish\n`,
		]);

		registry.publish(B, "2.1.3");
		const refused = await planPush(source, withdrawal);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toMatch(/published release records were removed[\s\S]*- @zeroclover\/pi-b@2.1.3/);
	});

	// package-releases: A withdrawn preparation cannot regain publishing authority.
	it("never lets the withdrawn preparation publish again, even when the same records are prepared anew", async () => {
		const { source, withdrawal } = await withdrawn();
		await repo.push();
		const again = await prepare();
		await repo.push();
		expect(await repo.show(again, ".changeset/ledger.yaml")).toBe(await repo.show(source, ".changeset/ledger.yaml"));

		const authorize = (sha: string) => repo.cli("authorize", "--source", sha, "--default-branch", "master");
		const old = await authorize(source);
		expect(old.code).toBe(1);
		expect(old.stderr).toMatch(new RegExp(`lost its publishing authority[\\s\\S]*was removed at ${withdrawal}`));
		const dispatch = await repo.cli(
			"plan",
			"--event",
			"dispatch",
			"--source",
			source,
			"--repo",
			GITHUB_REPO,
			"--default-branch",
			"master",
			"--registry",
			registry.url,
		);
		expect(dispatch.code).toBe(1);
		expect(dispatch.stderr).toMatch(/lost its publishing authority/);

		const fresh = await authorize(again);
		expect(fresh.code, fresh.output).toBe(0);
		expect(fresh.stdout).toContain(`authorized ${again}`);
	});
});
