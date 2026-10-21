import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistryDouble } from "./registry.ts";
import { A, B, features, GITHUB_REPO, seed, TestRepo } from "./repo.ts";

let registry: RegistryDouble;
let repo: TestRepo;
let scratch: string;
let artifacts: string;
let source: string;
let parent: string;
let verified: Awaited<ReturnType<TestRepo["cli"]>>;

interface BatchFile {
	source: string;
	members: { key: string; file: string; sha256: string }[];
}

beforeAll(async () => {
	registry = await RegistryDouble.start();
	repo = await TestRepo.create(registry);
	scratch = await mkdtemp(join(tmpdir(), "release-publish-"));
	await seed(repo);
	parent = await features(repo);
	source = await repo.pullRequest("chore(release): prepare", () => repo.version());
	await repo.push();
	artifacts = join(scratch, "artifacts");
	// CI creates both directories before verify runs.
	await mkdir(artifacts);
	await mkdir(join(scratch, "work"));
	verified = await repo.cli(
		"verify",
		"--source",
		source,
		"--source-dir",
		repo.dir,
		"--out",
		artifacts,
		"--work-dir",
		join(scratch, "work"),
	);
}, 60_000);

afterAll(async () => {
	await repo.cleanup();
	await registry.close();
	await rm(scratch, { recursive: true, force: true });
});

/** Before each publication: pi-b 2.1.1 and 2.1.2 on the registry, no tag and no release on GitHub. */
beforeEach(async () => {
	registry.reset();
	registry.publish(B, "2.1.1");
	registry.publish(B, "2.1.2");
	await repo.gh.update((state) => {
		state.tags = {};
		state.releases = {};
		state.failOnce = [];
		state.calls = [];
	});
});

function publish(dir = artifacts) {
	return repo.cli(
		"publish",
		"--source",
		source,
		"--artifacts",
		dir,
		"--repo",
		GITHUB_REPO,
		"--default-branch",
		"master",
		"--registry",
		registry.url,
	);
}

async function batch(): Promise<BatchFile> {
	return JSON.parse(await readFile(join(artifacts, "batch.json"), "utf8"));
}

/** GitHub calls that create something, from the stub's call log. */
async function creations(): Promise<string[]> {
	return (await repo.gh.read()).calls.filter(
		(call) => call.startsWith("create-tag") || call.startsWith("release-create"),
	);
}

/** The CHANGELOG section of a version at the release commit, as reviewed. */
async function section(dirName: string, version: string): Promise<string> {
	const changelog = await repo.show(source, `packages/${dirName}/CHANGELOG.md`);
	const start = changelog.indexOf(`## ${version}\n`);
	const next = changelog.indexOf("\n## ", start + 1);
	return changelog.slice(start + `## ${version}\n`.length, next < 0 ? undefined : next).trim();
}

describe("cli.ts verify and publish", { timeout: 60_000 }, () => {
	// package-releases: Validate the actual installable package.
	it("verifies the packed, installed, and loaded tarballs of the whole batch before anything is published", async () => {
		expect(verified.code, verified.output).toBe(0);
		const { members, source: verifiedSource } = await batch();
		expect(verifiedSource).toBe(source);
		expect(members.map((member) => member.key)).toEqual([`${A}@0.1.0`, `${B}@2.1.3`]);
		expect(verified.stdout).toContain(`verified ${A}@0.1.0: zeroclover-pi-a-0.1.0.tgz sha256 `);
		expect(verified.stdout).toContain("commands [pi-a]");
		expect(verified.stdout).toContain("commands [pi-b]");
	});

	// package-releases: Release descriptions come from reviewed prose, Tags record package versions after publication, Retry the original batch without new version decisions.
	it("uploads the verified bytes once, tags the release commit, announces the changelog, and a rerun does nothing", async () => {
		const first = await publish();
		expect(first.code, first.output).toBe(0);
		const { members } = await batch();
		expect(registry.uploads).toEqual(
			members.map((member) => ({
				name: member.key.slice(0, member.key.lastIndexOf("@")),
				version: member.key.slice(member.key.lastIndexOf("@") + 1),
				sha256: member.sha256,
			})),
		);
		const state = await repo.gh.read();
		expect(state.tags).toEqual({ [`${A}@0.1.0`]: source, [`${B}@2.1.3`]: source });
		expect(state.releases[`${A}@0.1.0`]).toEqual({ title: `${A}@0.1.0`, notes: `${await section("pi-a", "0.1.0")}\n` });
		expect(state.releases[`${B}@2.1.3`]?.notes).toBe(`${await section("pi-b", "2.1.3")}\n`);
		expect(state.releases[`${B}@2.1.3`]?.notes).toMatch(/B urgent fix/);

		await repo.gh.update((next) => {
			next.calls = [];
		});
		const rerun = await publish();
		expect(rerun.code, rerun.output).toBe(0);
		expect(registry.uploads).toHaveLength(2);
		expect(await creations()).toEqual([]);
		expect(rerun.stdout).toContain(`| \`${A}@0.1.0\` | already-published | existing | existing |  |`);
	});

	// package-releases: Retry the original batch without new version decisions (an outage is not "not published").
	it("stops without uploading when a registry lookup fails", async () => {
		registry.failLookups(1);
		const result = await publish();
		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(/HTTP 500; only 404 counts as absence/);
		expect(registry.uploads).toEqual([]);
		expect(await creations()).toEqual([]);
	});

	// package-releases: Recover using only the original release SHA, Retry the original batch without new version decisions.
	it("finishes a half-announced release on rerun without uploading again", async () => {
		await repo.gh.update((state) => {
			state.failOnce = [`release-create ${A}@0.1.0`];
		});
		const failed = await publish();
		expect(failed.code).toBe(1);
		expect(registry.uploads).toHaveLength(2);
		expect(Object.keys((await repo.gh.read()).releases)).toEqual([`${B}@2.1.3`]);

		await repo.gh.update((state) => {
			state.calls = [];
		});
		const rerun = await publish();
		expect(rerun.code, rerun.output).toBe(0);
		expect(registry.uploads).toHaveLength(2);
		expect(await creations()).toEqual([`release-create ${A}@0.1.0`]);
	});

	// package-releases: Tags record package versions after publication (never moved).
	it("fails rather than move a tag that points to another commit", async () => {
		await repo.gh.update((state) => {
			state.tags[`${B}@2.1.3`] = parent;
		});
		const result = await publish();
		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(
			/tag @zeroclover\/pi-b@2.1.3 points to [0-9a-f]+, not the release commit .* tags are never moved/,
		);
		const state = await repo.gh.read();
		expect(state.tags[`${B}@2.1.3`]).toBe(parent);
		expect(state.releases[`${B}@2.1.3`]).toBeUndefined();
	});

	// package-releases: Validate the actual installable package (publish accepts only the verified bytes).
	it("refuses a tarball altered after verification before any upload", async () => {
		const altered = join(scratch, "altered");
		await cp(artifacts, altered, { recursive: true });
		const file = join(altered, "zeroclover-pi-b-2.1.3.tgz");
		await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("tampered")]));
		const result = await publish(altered);
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(
			/nothing was uploaded[\s\S]*zeroclover-pi-b-2.1.3.tgz differs from the verified artifact/,
		);
		expect(registry.uploads).toEqual([]);
	});
});
