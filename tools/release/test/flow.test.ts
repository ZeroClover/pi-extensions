import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorize, checkCoverage, type Deps, planDispatch, planPush, publishRelease } from "../src/commands.ts";
import { runCommand } from "../src/exec.ts";
import { Git } from "../src/git.ts";
import type { GitHub } from "../src/github.ts";
import { BATCH_FILE, type PublishEffects, sha256 } from "../src/publish.ts";
import { ReleaseRepository } from "../src/repository.ts";
import { changelogText, intentText, ledgerText, manifestText } from "./fixtures.ts";
import { TestRepo } from "./git-repo.ts";

const A = "@zeroclover/pi-a";
const B = "@zeroclover/pi-b";
const ZERO = "0".repeat(40);

let repo: TestRepo;
/** GitHub's commit -> merged pull request association: pull request number and its merge commit. */
let pulls: Map<string, { readonly number: number; readonly mergeCommitSha: string }>;
let nextPull = 1;

/** Marks a commit as the squash or merge commit of its own merged pull request. */
function integrate(sha: string): string {
	pulls.set(sha, { number: nextPull++, mergeCommitSha: sha });
	return sha;
}
/** Versions the registry double reports as published. */
let published: Set<string>;

function unexpected(): never {
	throw new Error("unexpected GitHub call");
}

function deps(): Deps {
	const github: GitHub = {
		pullsForCommit: async (sha) => {
			const pull = pulls.get(sha);
			return pull === undefined ? [] : [{ ...pull, merged: true, baseRef: "master" }];
		},
		tagTarget: unexpected,
		createTag: unexpected,
		releaseExists: unexpected,
		createRelease: unexpected,
	};
	return {
		repo: new ReleaseRepository(new Git(runCommand, repo.dir)),
		github,
		lookupVersion: async (name, version) =>
			published.has(`${name}@${version}`) ? { kind: "found", tarball: "t" } : { kind: "missing" },
	};
}

/** A merged pull request: one squash commit that GitHub associates with the pull request. */
async function squash(message: string, files: Record<string, string | null>): Promise<string> {
	return integrate(await repo.commit(message, files));
}

const B_CHANGELOG_BASE: readonly (readonly [string, string])[] = [["2.1.2", "### Patch Changes\n\n- Earlier fix"]];

/** Two plugins: A never released (0.1.0), B released at 2.1.2; intents for both are pending. */
async function seed(): Promise<string> {
	await repo.commit("chore: init", {
		"README.md": "# repo\n",
		"packages/pi-a/package.json": manifestText("pi-a", "0.1.0"),
		"packages/pi-a/src/index.ts": "export default function () {}\n",
		"packages/pi-b/package.json": manifestText("pi-b", "2.1.2"),
		"packages/pi-b/src/index.ts": "export default function () {}\n",
		"packages/pi-b/CHANGELOG.md": changelogText(B, B_CHANGELOG_BASE),
		".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier"] }),
	});
	return squash("feat: changes with their intents", {
		"packages/pi-a/src/index.ts": "export default function () { /* feature */ }\n",
		"packages/pi-b/src/index.ts": "export default function () { /* fix */ }\n",
		".changeset/a-feature.md": intentText({ [A]: "minor" }, "A feature"),
		".changeset/b-fix.md": intentText({ [B]: "patch" }, "B urgent fix"),
		".changeset/shared.md": intentText({ [A]: "patch", [B]: "patch" }, "Shared fix"),
	});
}

/** What `pnpm --filter @zeroclover/pi-b version -r` writes: A and the shared intent stay pending. */
function prepareB(notes = "### Patch Changes\n\n- Shared fix\n\n- B urgent fix"): Record<string, string | null> {
	return {
		"packages/pi-b/package.json": manifestText("pi-b", "2.1.3"),
		"packages/pi-b/CHANGELOG.md": changelogText(B, [["2.1.3", notes], ...B_CHANGELOG_BASE]),
		".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier"], [`${B}@2.1.3`]: ["b-fix", "shared"] }),
		".changeset/b-fix.md": null,
	};
}

/** What an unfiltered `pnpm version -r` writes after prepareB: A's first release keeps 0.1.0. */
function prepareA(): Record<string, string | null> {
	return {
		"packages/pi-a/CHANGELOG.md": changelogText(A, [
			["0.1.0", "### Minor Changes\n\n- A feature\n\n### Patch Changes\n\n- Shared fix"],
		]),
		".changeset/ledger.yaml": ledgerText({
			[`${A}@0.1.0`]: ["a-feature", "shared"],
			[`${B}@2.1.2`]: ["earlier"],
			[`${B}@2.1.3`]: ["b-fix", "shared"],
		}),
		".changeset/a-feature.md": null,
		".changeset/shared.md": null,
	};
}

beforeEach(async () => {
	repo = await TestRepo.create();
	pulls = new Map();
	published = new Set();
});

afterEach(async () => {
	await repo.cleanup();
});

describe("automatic publication plan", () => {
	it("publishes only B when B alone was prepared, leaving A and a new unreleased plugin out", async () => {
		const before = await seed();
		await repo.commit("feat: new plugin C without intent", {
			"packages/pi-c/package.json": manifestText("pi-c", "0.1.0"),
			"packages/pi-c/src/index.ts": "export default function () {}\n",
		});
		const parent = await repo.git("rev-parse", "HEAD");
		const after = await squash("chore(release): prepare pi-b", prepareB());
		const plan = await planPush(deps(), { before: parent, after, forced: false, defaultBranch: "master" });
		expect(plan.kind === "release" && plan.members.map((member) => [member.key, member.notes])).toEqual([
			[`${B}@2.1.3`, "### Patch Changes\n\n- Shared fix\n\n- B urgent fix"],
		]);
		expect(plan.kind === "release" && plan.parent).toBe(parent);
		expect(before).not.toBe(parent);
	});

	it("publishes independent versions together, recognizing a first release by its record", async () => {
		const before = await seed();
		const after = await squash("chore(release): prepare all", { ...prepareB(), ...prepareA() });
		const plan = await planPush(deps(), { before, after, forced: false, defaultBranch: "master" });
		expect(plan.kind === "release" && plan.members.map((member) => member.key)).toEqual([`${A}@0.1.0`, `${B}@2.1.3`]);
	});

	it("derives the batch from a multi-commit pull request's merge commit, with the final prose", async () => {
		const before = await seed();
		await repo.git("checkout", "-q", "-b", "release");
		await repo.commit("chore(release): pnpm version -r --filter pi-b", prepareB());
		await repo.commit("docs(pi-b): polish release notes", {
			"packages/pi-b/CHANGELOG.md": changelogText(B, [
				["2.1.3", "### Patch Changes\n\n- Fixed the urgent crash."],
				...B_CHANGELOG_BASE,
			]),
		});
		await repo.git("checkout", "-q", "master");
		const merge = await repo.merge("release", "Merge pull request #42 from release");
		integrate(merge);
		const plan = await planPush(deps(), { before, after: merge, forced: false, defaultBranch: "master" });
		expect(plan.kind === "release" && plan.members.map((member) => member.notes)).toEqual([
			"### Patch Changes\n\n- Fixed the urgent crash.",
		]);
	});

	it("treats documentation-only and empty initial pushes as successful no-ops", async () => {
		const before = await seed();
		const docs = await repo.commit("docs: typo", { "README.md": "# repo!\n" });
		expect(await planPush(deps(), { before, after: docs, forced: false, defaultBranch: "master" })).toEqual({
			kind: "no-op",
			reason: "release records are identical at both push endpoints",
		});
		const first = await repo.git("rev-list", "--max-parents=0", "HEAD");
		await expect(
			planPush(deps(), { before: ZERO, after: first, forced: false, defaultBranch: "master" }),
		).rejects.toThrow(/initial push already contains release records/);
		const bare = await TestRepo.create();
		try {
			const sha = await bare.commit("init", { "README.md": "x\n" });
			const plan = await planPush(
				{ ...deps(), repo: new ReleaseRepository(new Git(runCommand, bare.dir)) },
				{ before: ZERO, after: sha, forced: false, defaultBranch: "master" },
			);
			expect(plan).toEqual({ kind: "no-op", reason: "initial push without release records" });
		} finally {
			await bare.cleanup();
		}
	});

	it("rejects a preparation hidden behind a documentation commit of the same push", async () => {
		const before = await seed();
		await squash("chore(release): prepare pi-b", prepareB());
		const tip = await squash("docs: later", { "README.md": "# later\n" });
		await expect(planPush(deps(), { before, after: tip, forced: false, defaultBranch: "master" })).rejects.toThrow(
			/unsupported publication boundary[\s\S]*more than one integration/,
		);
	});

	it("rejects forced pushes and record changes without a merged pull request", async () => {
		const before = await seed();
		const direct = await repo.commit("chore(release): direct push", prepareB());
		await expect(planPush(deps(), { before, after: direct, forced: false, defaultBranch: "master" })).rejects.toThrow(
			/not the squash or merge commit of a pull request/,
		);
		integrate(direct);
		await expect(planPush(deps(), { before, after: direct, forced: true, defaultBranch: "master" })).rejects.toThrow(
			/forced/,
		);
	});

	it("fails closed on unreadable history and malformed records", async () => {
		const before = await seed();
		const after = await squash("chore(release): prepare pi-b", prepareB());
		await expect(
			planPush(deps(), { before: "1".repeat(40), after, forced: false, defaultBranch: "master" }),
		).rejects.toThrow(/is not available/);
		const broken = await squash("broken", { ".changeset/ledger.yaml": '"@zeroclover/pi-b@2.1.3": [\n' });
		await expect(
			planPush(deps(), { before: after, after: broken, forced: false, defaultBranch: "master" }),
		).rejects.toThrow(/invalid YAML/);
		expect(before).toHaveLength(40);
	});

	it("rejects edited records and version edits that bypass preparation", async () => {
		const before = await seed();
		const edited = await squash("edit", {
			".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier", "b-fix"] }),
		});
		await expect(planPush(deps(), { before, after: edited, forced: false, defaultBranch: "master" })).rejects.toThrow(
			/modified: @zeroclover\/pi-b@2.1.2/,
		);
		await repo.git("reset", "-q", "--hard", before);
		const manual = await squash("prepare B and hand-bump A", {
			...prepareB(),
			"packages/pi-a/package.json": manifestText("pi-a", "0.2.0"),
		});
		await expect(planPush(deps(), { before, after: manual, forced: false, defaultBranch: "master" })).rejects.toThrow(
			/pi-a\/package.json: version 0.1.0 -> 0.2.0 without a release record/,
		);
	});

	it("allows withdrawing an unpublished preparation but never published history", async () => {
		const before = await seed();
		const prepared = await squash("chore(release): prepare pi-b", prepareB());
		const withdrawal = await squash("revert: withdraw pi-b 2.1.3", {
			"packages/pi-b/package.json": manifestText("pi-b", "2.1.2"),
			"packages/pi-b/CHANGELOG.md": changelogText(B, B_CHANGELOG_BASE),
			".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier"] }),
			".changeset/b-fix.md": intentText({ [B]: "patch" }, "B urgent fix"),
		});
		const push = { before: prepared, after: withdrawal, forced: false, defaultBranch: "master" };
		expect(await planPush(deps(), push)).toEqual({
			kind: "no-op",
			reason: "withdrawal of unpublished @zeroclover/pi-b@2.1.3; nothing to publish",
		});
		published.add(`${B}@2.1.3`);
		await expect(planPush(deps(), push)).rejects.toThrow(/published release records were removed[\s\S]*pi-b@2.1.3/);
		expect(before).toHaveLength(40);
	});

	it("rejects withdrawals that do not restore the pending state or that edit other versions", async () => {
		await seed();
		const prepared = await squash("chore(release): prepare pi-b", prepareB());
		const revert = {
			"packages/pi-b/package.json": manifestText("pi-b", "2.1.2"),
			"packages/pi-b/CHANGELOG.md": changelogText(B, B_CHANGELOG_BASE),
			".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier"] }),
			".changeset/b-fix.md": intentText({ [B]: "patch" }, "B urgent fix"),
		};
		const incomplete = await squash("revert: drop the record only", {
			".changeset/ledger.yaml": revert[".changeset/ledger.yaml"],
		});
		await expect(
			planPush(deps(), { before: prepared, after: incomplete, forced: false, defaultBranch: "master" }),
		).rejects.toThrow(
			/withdrawal in .* is invalid[\s\S]*intent "b-fix" is not restored[\s\S]*still has the "## 2.1.3" section[\s\S]*has version 2.1.3; the withdrawal must restore 2.1.2/,
		);
		expect((await checkCoverage(deps().repo, prepared, incomplete)).problems.join("\n")).toMatch(
			/intent "b-fix" is not restored/,
		);
		await repo.git("reset", "-q", "--hard", prepared);
		const impure = await squash("revert: withdraw pi-b and bump pi-a by hand", {
			...revert,
			"packages/pi-a/package.json": manifestText("pi-a", "0.2.0"),
		});
		await expect(
			planPush(deps(), { before: prepared, after: impure, forced: false, defaultBranch: "master" }),
		).rejects.toThrow(/pi-a\/package.json: version 0.1.0 -> 0.2.0 without a release record/);
		await repo.git("reset", "-q", "--hard", prepared);
		const arbitrary = await squash("revert: withdraw pi-b to an unrelated version", {
			...revert,
			"packages/pi-b/package.json": manifestText("pi-b", "99.0.0"),
		});
		await expect(
			planPush(deps(), { before: prepared, after: arbitrary, forced: false, defaultBranch: "master" }),
		).rejects.toThrow(/has version 99.0.0; the withdrawal must restore 2.1.2/);
		expect((await checkCoverage(deps().repo, prepared, arbitrary)).problems.join("\n")).toMatch(/must restore 2.1.2/);
	});

	it("rejects a new record that reuses a shared intent the plugin already consumed", async () => {
		await seed();
		const first = await squash("chore(release): prepare pi-b", prepareB());
		const reuse = await squash("chore(release): hand-made record", {
			"packages/pi-b/package.json": manifestText("pi-b", "2.1.4"),
			"packages/pi-b/CHANGELOG.md": changelogText(B, [
				["2.1.4", "- Shared fix again"],
				["2.1.3", "- Earlier"],
				...B_CHANGELOG_BASE,
			]),
			".changeset/ledger.yaml": ledgerText({
				[`${B}@2.1.2`]: ["earlier"],
				[`${B}@2.1.3`]: ["b-fix", "shared"],
				[`${B}@2.1.4`]: ["shared"],
			}),
		});
		await expect(
			planPush(deps(), { before: first, after: reuse, forced: false, defaultBranch: "master" }),
		).rejects.toThrow(/"shared" had already been consumed by @zeroclover\/pi-b/);
	});

	it("rejects a preparation that landed through a rebase merge, on push and on dispatch", async () => {
		const before = await seed();
		await repo.push();
		const c1 = await repo.commit("docs: first commit of the pull request", { "README.md": "# rebased\n" });
		const c2 = await repo.commit("chore(release): prepare pi-b", prepareB());
		const number = nextPull++;
		pulls.set(c1, { number, mergeCommitSha: c2 });
		pulls.set(c2, { number, mergeCommitSha: c2 });
		await repo.push();
		await expect(planPush(deps(), { before, after: c2, forced: false, defaultBranch: "master" })).rejects.toThrow(
			/more than one integration/,
		);
		await expect(planDispatch(deps(), { sourceSha: c2, defaultBranch: "master", remote: "origin" })).rejects.toThrow(
			new RegExp(`both come from pull request #${number}: a rebase merge`),
		);
	});
});

describe("authorization continuity and recovery", () => {
	async function preparedAndPushed(): Promise<string> {
		await seed();
		const x = await squash("chore(release): prepare pi-b", prepareB());
		await repo.push();
		return x;
	}

	it("keeps X eligible through unrelated work and formatting-only ledger rewrites, recording the fresh head", async () => {
		const x = await preparedAndPushed();
		await squash("docs: unrelated", { "README.md": "# unrelated\n" });
		const requoted = [
			"'@zeroclover/pi-b@2.1.2': { dir: ./packages/pi-b, intents: [earlier] }",
			"'@zeroclover/pi-b@2.1.3':",
			"    dir: packages/pi-b/",
			"    intents: [shared, b-fix]",
			"",
		].join("\n");
		const head = await squash("style: requote ledger keys", { ".changeset/ledger.yaml": requoted });
		await repo.push();
		const result = await authorize(deps().repo, { sourceSha: x, defaultBranch: "master", remote: "origin" });
		expect([result.source, result.head, result.members.map((member) => member.key)]).toEqual([x, head, [`${B}@2.1.3`]]);
	});

	it("loses authority after a record mutation that keeps the key count, even once restored", async () => {
		const x = await preparedAndPushed();
		const records = { [`${B}@2.1.2`]: ["earlier"] };
		const mutation = await squash("mutate", {
			".changeset/ledger.yaml": ledgerText({ ...records, [`${B}@2.1.3`]: ["b-fix", "other"] }),
		});
		await squash("restore", {
			".changeset/ledger.yaml": ledgerText({ ...records, [`${B}@2.1.3`]: ["b-fix", "shared"] }),
		});
		expect(await repo.git("show", `${x}:.changeset/ledger.yaml`)).toBe(
			await repo.git("show", "HEAD:.changeset/ledger.yaml"),
		);
		await repo.push();
		await expect(authorize(deps().repo, { sourceSha: x, defaultBranch: "master", remote: "origin" })).rejects.toThrow(
			new RegExp(`lost its publishing authority[\\s\\S]*pi-b@2.1.3 was modified at ${mutation}`),
		);
	});

	it("rejects X after withdrawal even when Y prepares the identical record again, and accepts Y", async () => {
		const x = await preparedAndPushed();
		const withdrawal = await squash("revert: withdraw", {
			"packages/pi-b/package.json": manifestText("pi-b", "2.1.2"),
			"packages/pi-b/CHANGELOG.md": changelogText(B, B_CHANGELOG_BASE),
			".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier"] }),
			".changeset/b-fix.md": intentText({ [B]: "patch" }, "B urgent fix"),
		});
		const y = await squash("chore(release): prepare pi-b again", prepareB());
		await repo.push();
		const entryPoints = [
			() => authorize(deps().repo, { sourceSha: x, defaultBranch: "master", remote: "origin" }),
			() => planDispatch(deps(), { sourceSha: x, defaultBranch: "master", remote: "origin" }),
		];
		for (const entryPoint of entryPoints) {
			await expect(entryPoint()).rejects.toThrow(new RegExp(`pi-b@2.1.3 was removed at ${withdrawal}`));
		}
		await expect(
			planDispatch(deps(), { sourceSha: y, defaultBranch: "master", remote: "origin" }),
		).resolves.toMatchObject({
			kind: "release",
			source: y,
		});
		expect((await authorize(deps().repo, { sourceSha: y, defaultBranch: "master", remote: "origin" })).source).toBe(y);
	});

	it("recovers from only the original SHA after the rerun window, deriving the parent", async () => {
		const x = await preparedAndPushed();
		const parent = await repo.git("rev-parse", `${x}^`);
		await squash("docs: later", { "README.md": "# later\n" });
		await repo.push();
		const plan = await planDispatch(deps(), { sourceSha: x.slice(0, 12), defaultBranch: "master", remote: "origin" });
		expect([plan.source, plan.parent, plan.members.map((member) => member.key)]).toEqual([x, parent, [`${B}@2.1.3`]]);
		await expect(
			planDispatch(deps(), { sourceSha: "master", defaultBranch: "master", remote: "origin" }),
		).rejects.toThrow(/must be a commit SHA/);
		const docs = await repo.git("rev-parse", "HEAD");
		await expect(planDispatch(deps(), { sourceSha: docs, defaultBranch: "master", remote: "origin" })).rejects.toThrow(
			/not a release preparation/,
		);
	});

	it("rejects recovery targets off the first-parent history or without fresh evidence", async () => {
		await seed();
		await repo.git("checkout", "-q", "-b", "side");
		const side = await repo.commit("chore(release): prepare on a side branch", prepareB());
		integrate(side);
		await repo.git("checkout", "-q", "master");
		await repo.merge("side", "merge side");
		await repo.push();
		await expect(
			authorize(deps().repo, { sourceSha: side, defaultBranch: "master", remote: "origin" }),
		).rejects.toThrow(/not on the first-parent history/);
		await expect(
			authorize(deps().repo, { sourceSha: side, defaultBranch: "master", remote: "nowhere" }),
		).rejects.toThrow(/git fetch/);
	});

	it("retries a partial A/B release from X after HEAD advanced: skips A, uploads B, tags X", async () => {
		await seed();
		const x = await squash("chore(release): prepare all", { ...prepareB(), ...prepareA() });
		await squash("docs: unrelated", { "README.md": "# advanced\n" });
		await repo.push();
		const artifacts = await mkdtemp(join(tmpdir(), "release-retry-"));
		try {
			const members = [
				{ key: `${A}@0.1.0`, file: "a.tgz" },
				{ key: `${B}@2.1.3`, file: "b.tgz" },
			];
			for (const { file } of members) {
				await writeFile(join(artifacts, file), file);
			}
			const batch = {
				source: x,
				members: members.map(({ key, file }) => ({ key, file, sha256: sha256(Buffer.from(file)) })),
			};
			await writeFile(join(artifacts, BATCH_FILE), JSON.stringify(batch));
			const calls: string[] = [];
			const effects: PublishEffects = {
				lookupVersion: async (name, version) =>
					name === A ? { kind: "found", tarball: `${name}@${version}.tgz` } : { kind: "missing" },
				tarballAvailable: async () => true,
				upload: async (tarball) => {
					calls.push(`upload ${tarball.slice(artifacts.length + 1)}`);
				},
				tagTarget: async () => undefined,
				createTag: async (tag, sha) => {
					calls.push(`tag ${tag} ${sha === x ? "X" : sha}`);
				},
				releaseExists: async () => false,
				createRelease: async (tag) => {
					calls.push(`release ${tag}`);
				},
			};
			const result = await publishRelease(deps().repo, effects, {
				sourceSha: x,
				defaultBranch: "master",
				remote: "origin",
				artifactsDir: artifacts,
			});
			expect(result.authorization.head).not.toBe(x);
			expect(calls).toEqual([
				"upload b.tgz",
				`tag ${A}@0.1.0 X`,
				`release ${A}@0.1.0`,
				`tag ${B}@2.1.3 X`,
				`release ${B}@2.1.3`,
			]);
		} finally {
			await rm(artifacts, { recursive: true, force: true });
		}
	});
});

describe("pull request release-impact gate", () => {
	it("fails a source change covered only by a stale intent, and passes with its own decision", async () => {
		const base = await seed();
		await repo.git("checkout", "-q", "-b", "feature");
		const change = await repo.commit("fix(pi-a): another fix", {
			"packages/pi-a/src/index.ts": "export default function () { /* 2 */ }\n",
		});
		const stale = await checkCoverage(deps().repo, base, change);
		expect(stale.problems).toEqual([
			expect.stringMatching(/@zeroclover\/pi-a: published files changed .* no release decision/),
		]);
		const decided = await repo.commit("chore: intent", {
			".changeset/quick-fix.md": intentText({ [A]: "patch" }, "Another fix"),
		});
		const report = await checkCoverage(deps().repo, base, decided);
		expect([report.problems, report.plugins.map((plugin) => plugin.decision)]).toEqual([
			[],
			["patch release (.changeset/quick-fix.md)"],
		]);
	});

	it("accepts a preparation pull request through its validated records", async () => {
		const base = await seed();
		await repo.git("checkout", "-q", "-b", "release");
		const head = await repo.commit("chore(release): prepare pi-b", prepareB());
		const report = await checkCoverage(deps().repo, base, head);
		expect([report.problems, report.plugins.map((plugin) => [plugin.name, plugin.decision])]).toEqual([
			[],
			[[B, "prepared release record"]],
		]);
	});

	it("gates a withdrawal of a shared-intent-only preparation by its validated records", async () => {
		await repo.commit("chore: init", {
			"packages/pi-a/package.json": manifestText("pi-a", "0.1.0"),
			"packages/pi-b/package.json": manifestText("pi-b", "2.1.2"),
			"packages/pi-b/CHANGELOG.md": changelogText(B, B_CHANGELOG_BASE),
			".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier"] }),
			".changeset/shared.md": intentText({ [A]: "patch", [B]: "patch" }, "Shared fix"),
		});
		const prepared = await squash("chore(release): prepare pi-b", {
			"packages/pi-b/package.json": manifestText("pi-b", "2.1.3"),
			"packages/pi-b/CHANGELOG.md": changelogText(B, [
				["2.1.3", "### Patch Changes\n\n- Shared fix"],
				...B_CHANGELOG_BASE,
			]),
			".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier"], [`${B}@2.1.3`]: ["shared"] }),
		});
		await repo.git("checkout", "-q", "-b", "withdraw");
		const withdrawal = await repo.commit("revert: withdraw pi-b 2.1.3", {
			"packages/pi-b/package.json": manifestText("pi-b", "2.1.2"),
			"packages/pi-b/CHANGELOG.md": changelogText(B, B_CHANGELOG_BASE),
			".changeset/ledger.yaml": ledgerText({ [`${B}@2.1.2`]: ["earlier"] }),
		});
		const report = await checkCoverage(deps().repo, prepared, withdrawal);
		expect([report.problems, report.plugins.map((plugin) => [plugin.name, plugin.decision])]).toEqual([
			[],
			[[B, `withdrawal of ${B}@2.1.3`]],
		]);
	});

	it("reports a stacked preparation as a duplicate changelog section", async () => {
		const base = await seed();
		await repo.git("checkout", "-q", "-b", "release");
		const head = await repo.commit("chore(release): prepare pi-b twice", {
			...prepareB(),
			"packages/pi-b/CHANGELOG.md": changelogText(B, [
				["2.1.3", "- second"],
				["2.1.3", "- first"],
				...B_CHANGELOG_BASE,
			]),
		});
		const report = await checkCoverage(deps().repo, base, head);
		expect(report.problems.join("\n")).toMatch(/2 "## 2.1.3" sections/);
	});
});
