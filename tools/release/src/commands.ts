import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	assertOutside,
	installAndLoad,
	type PackedArtifact,
	packArtifact,
	type VerifiedArtifact,
	type VerifyContext,
} from "./artifact.ts";
import { continuityProblems } from "./authorization.ts";
import {
	boundaryProblems,
	classifyTransition,
	compareEndpoints,
	findIntegration,
	type PreparedMember,
	type PullRequest,
	unpreparedVersionChanges,
} from "./batch.ts";
import { evaluateCoverage, type PluginCoverage } from "./coverage.ts";
import { errorMessage, ReleaseError } from "./errors.ts";
import { Git } from "./git.ts";
import type { GitHub } from "./github.ts";
import { type ChangeIntent, intentIdOf } from "./intents.ts";
import { consumedBy, releaseKey } from "./ledger.ts";
import { identityProblems, pluginDir, pluginName } from "./manifest.ts";
import {
	type Artifact,
	BATCH_FILE,
	loadArtifacts,
	type MemberReport,
	type PublishEffects,
	publishBatch,
} from "./publish.ts";
import type { VersionLookup } from "./registry.ts";
import type { ReleaseRepository } from "./repository.ts";

export interface Deps {
	readonly repo: ReleaseRepository;
	readonly github: GitHub;
	readonly lookupVersion: (name: string, version: string) => Promise<VersionLookup>;
}

export type Plan =
	| { readonly kind: "no-op"; readonly reason: string }
	| {
			readonly kind: "release";
			readonly source: string;
			readonly parent: string;
			readonly pull: number;
			readonly members: readonly PreparedMember[];
	  };

export interface Authorization {
	readonly source: string;
	readonly parent: string;
	/** The freshly fetched default-branch head: authorization evidence only, never a release source. */
	readonly head: string;
	readonly members: readonly PreparedMember[];
}

export interface CoverageReport {
	readonly mergeBase: string;
	readonly head: string;
	readonly plugins: readonly PluginCoverage[];
	readonly notices: readonly string[];
	readonly problems: readonly string[];
}

const ZERO_SHA = /^0+$/;
const SHA_INPUT = /^[0-9a-f]{7,64}$/;

function problemList(heading: string, problems: readonly string[]): ReleaseError {
	return new ReleaseError(`${heading}\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
}

/** The PR release-impact gate, evaluated between the merge base and the head. */
export async function checkCoverage(
	repo: ReleaseRepository,
	baseRev: string,
	headRev: string,
): Promise<CoverageReport> {
	const { git } = repo;
	const head = await git.commit(headRev);
	const mergeBase = await git.mergeBase(await git.commit(baseRev), head);
	const changedPaths = await git.changedPaths(mergeBase, head);
	const manifests = await repo.manifestsAt(head);
	const problems: string[] = [];
	const notices: string[] = [];
	for (const [dirName, manifest] of manifests) {
		problems.push(...identityProblems(dirName, manifest));
	}
	const baseIntents = new Map<string, ChangeIntent>();
	const headIntents = new Map<string, ChangeIntent>();
	for (const id of changedPaths.map(intentIdOf)) {
		if (id === undefined) {
			continue;
		}
		try {
			const before = await repo.intentAt(mergeBase, id);
			const after = await repo.intentAt(head, id);
			if (before !== undefined) {
				baseIntents.set(id, before);
			}
			if (after !== undefined) {
				headIntents.set(id, after);
			}
		} catch (error) {
			problems.push(errorMessage(error));
		}
	}
	const baseLedger = await repo.ledgerAt(mergeBase);
	const prepared = new Set<string>();
	const preparedKeys = new Set<string>();
	const withdrawn = new Map<string, string>();
	const withdrawnKeys = new Set<string>();
	try {
		const transition = classifyTransition(baseLedger, await repo.ledgerAt(head));
		if (transition.kind === "release") {
			const result = await repo.prepareMembers(transition.members, head, mergeBase);
			problems.push(...result.problems);
			for (const member of result.prepared) {
				prepared.add(member.name);
				preparedKeys.add(member.key);
			}
		} else if (transition.kind === "withdrawal") {
			for (const record of transition.removed) {
				withdrawnKeys.add(record.key);
				const recordProblems = await repo.withdrawalProblems([record], head);
				problems.push(...recordProblems);
				if (recordProblems.length === 0) {
					withdrawn.set(record.name, record.key);
				}
			}
			notices.push(
				`withdraws ${[...withdrawnKeys].join(", ")}: only for a batch that never entered upload, with every publishing attempt stopped (docs/releases.md); publication re-checks the registry`,
			);
		}
	} catch (error) {
		problems.push(errorMessage(error));
	}
	problems.push(...unpreparedVersionChanges(await repo.manifestsAt(mergeBase), manifests, preparedKeys, withdrawnKeys));
	const consumed = new Map(
		[...manifests.keys()].map((dirName) => {
			const name = pluginName(dirName);
			return [name, consumedBy(baseLedger, { name, dir: pluginDir(dirName) })] as const;
		}),
	);
	const plugins = evaluateCoverage({
		changedPaths,
		plugins: [...manifests].map(([dirName, manifest]) => ({ dirName, manifest })),
		baseIntents,
		headIntents,
		prepared,
		withdrawn,
		consumed,
	});
	for (const plugin of plugins.filter((entry) => entry.decision === undefined)) {
		problems.push(
			`${plugin.name}: published files changed (${plugin.changed.join(", ")}) but this pull request records no release decision; run pnpm change --bump <patch|minor|major|none> --summary "<user-facing change, or why no release>" ${pluginName(plugin.dirName)}`,
		);
	}
	return { mergeBase, head, plugins, notices, problems };
}

/** Records changed in a supported release push: derive and validate the first-parent batch. */
async function evaluate(deps: Deps, source: string, pull: PullRequest): Promise<Plan> {
	const batch = await deps.repo.readBatch(source);
	if (batch.kind === "unchanged") {
		return { kind: "no-op", reason: "no new release records relative to the first parent" };
	}
	if (batch.kind === "withdrawal") {
		const published: string[] = [];
		for (const { name, version } of batch.removed) {
			if ((await deps.lookupVersion(name, version)).kind === "found") {
				published.push(releaseKey(name, version));
			}
		}
		if (published.length > 0) {
			throw problemList("published release records were removed; published history is never withdrawn:", published);
		}
		const keys = batch.removed.map(({ name, version }) => releaseKey(name, version)).join(", ");
		return { kind: "no-op", reason: `withdrawal of unpublished ${keys}; nothing to publish` };
	}
	return { kind: "release", source, parent: batch.parent, pull: pull.number, members: batch.members };
}

/** Automatic publication: endpoint no-op detection, then the boundary guard, then the fixed-parent batch. */
export async function planPush(
	deps: Deps,
	push: { readonly before: string; readonly after: string; readonly forced: boolean; readonly defaultBranch: string },
): Promise<Plan> {
	const { repo } = deps;
	const after = await repo.git.commit(push.after);
	const before = ZERO_SHA.test(push.before) ? undefined : await repo.git.commit(push.before);
	const endpoint = compareEndpoints(
		before === undefined ? undefined : await repo.ledgerAt(before),
		await repo.ledgerAt(after),
	);
	if (endpoint.kind === "no-op") {
		return endpoint;
	}
	const parents = await repo.git.parents(after);
	const problems = boundaryProblems({ before: before ?? push.before, after, forced: push.forced, parents });
	if (problems.length > 0) {
		throw problemList(
			"release records changed across an unsupported publication boundary; nothing is published:",
			problems,
		);
	}
	const pull = await integration(deps, after, push.defaultBranch, parents);
	return evaluate(deps, after, pull);
}

/** The merged pull request that integrated `source`, rejecting anything but Squash or Merge. */
async function integration(
	deps: Deps,
	source: string,
	defaultBranch: string,
	parents: readonly string[],
): Promise<PullRequest> {
	const [firstParent] = parents;
	const firstParentPulls = firstParent === undefined ? [] : await deps.github.pullsForCommit(firstParent);
	return findIntegration(source, defaultBranch, parents, await deps.github.pullsForCommit(source), firstParentPulls);
}

/**
 * Manual recovery: only the original release integration commit. Its first parent is derived, it
 * must be a merged pull request's commit on the default branch, and it must pass the same
 * authorization preflight that guards publication, so a withdrawn preparation stops here.
 */
export async function planDispatch(
	deps: Deps,
	input: { readonly sourceSha: string; readonly defaultBranch: string; readonly remote: string },
): Promise<Plan & { readonly kind: "release" }> {
	if (!SHA_INPUT.test(input.sourceSha)) {
		throw new ReleaseError(`source_sha must be a commit SHA, not "${input.sourceSha}"`);
	}
	const authorization = await authorize(deps.repo, input);
	const { source, parent, members } = authorization;
	const pull = await integration(deps, source, input.defaultBranch, await deps.repo.git.parents(source));
	return { kind: "release", source, parent, pull: pull.number, members };
}

/**
 * The shared authorization preflight of every publishing entry point, run under publication
 * serialization: the release commit must be on the freshly fetched default branch's first-parent
 * history, and every original batch record must have stayed present and unchanged since.
 */
export async function authorize(
	repo: ReleaseRepository,
	input: { readonly sourceSha: string; readonly defaultBranch: string; readonly remote: string },
): Promise<Authorization> {
	const source = await repo.git.commit(input.sourceSha);
	const head = await repo.git.fetchBranch(input.remote, input.defaultBranch);
	const later = await repo.git.firstParentAfter(source, head);
	const batch = await repo.readBatch(source);
	if (batch.kind !== "release") {
		throw new ReleaseError(`${source} is not a release preparation`);
	}
	const problems = continuityProblems(batch.members, await repo.snapshotsAfter(source, later));
	if (problems.length > 0) {
		throw problemList(
			`preparation ${source} lost its publishing authority (checked through ${head}); it can never be published, rerun, or dispatched again, so prepare the release again:`,
			problems,
		);
	}
	return { source, parent: batch.parent, head, members: batch.members };
}

/** Whole-batch artifact preflight; writes the validated tarballs and their manifest only when every member passes. */
export async function verifyRelease(
	repo: ReleaseRepository,
	ctx: VerifyContext,
	sourceSha: string,
): Promise<{ readonly source: string; readonly artifacts: readonly VerifiedArtifact[] }> {
	const source = await repo.git.commit(sourceSha);
	const checkout = await new Git(ctx.run, ctx.sourceDir).commit("HEAD");
	if (checkout !== source) {
		throw new ReleaseError(`the source checkout is at ${checkout}, not the release commit ${source}`);
	}
	assertOutside(ctx.sourceDir, ctx.workDir);
	const batch = await repo.readBatch(source);
	if (batch.kind !== "release") {
		throw new ReleaseError(`${source} is not a release preparation`);
	}
	const failed = (problems: readonly string[]): ReleaseError =>
		problemList("artifact preflight failed; no member of this batch may be uploaded:", problems);
	const packed: PackedArtifact[] = [];
	const problems: string[] = [];
	for (const member of batch.members) {
		try {
			packed.push(await packArtifact(ctx, member));
		} catch (error) {
			problems.push(`${member.key}: ${errorMessage(error)}`);
		}
	}
	if (problems.length > 0) {
		throw failed(problems);
	}
	const artifacts: VerifiedArtifact[] = [];
	for (const artifact of packed) {
		try {
			artifacts.push(await installAndLoad(ctx, artifact, packed));
		} catch (error) {
			problems.push(`${artifact.member.key}: ${errorMessage(error)}`);
		}
	}
	if (problems.length > 0) {
		throw failed(problems);
	}
	const file = { source, members: artifacts.map(({ key, file, sha256 }) => ({ key, file, sha256 })) };
	await writeFile(join(ctx.outDir, BATCH_FILE), `${JSON.stringify(file, null, "\t")}\n`);
	return { source, artifacts };
}

/** Authorization preflight, artifact preflight, then publication of the complete original batch. */
export async function publishRelease(
	repo: ReleaseRepository,
	effects: PublishEffects,
	input: {
		readonly sourceSha: string;
		readonly defaultBranch: string;
		readonly remote: string;
		readonly artifactsDir: string;
	},
): Promise<{ readonly authorization: Authorization; readonly reports: readonly MemberReport[] }> {
	const authorization = await authorize(repo, input);
	const artifacts: Artifact[] = await loadArtifacts(input.artifactsDir, authorization.source, authorization.members);
	return { authorization, reports: await publishBatch(authorization.source, artifacts, effects) };
}
