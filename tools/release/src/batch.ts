import { rcompare } from "semver";
import { releaseNotes, releaseSectionCount } from "./changelog.ts";
import { errorMessage, ReleaseError } from "./errors.ts";
import { bumpFor, type ChangeIntent } from "./intents.ts";
import {
	consumedBy,
	diffLedgers,
	type Ledger,
	type LedgerRecord,
	type ReleaseKey,
	sameLedger,
	splitReleaseKey,
} from "./ledger.ts";
import {
	dependsOnVersion,
	dirNameOfPlugin,
	identityProblems,
	type PluginManifest,
	pluginDir,
	pluginDirName,
} from "./manifest.ts";

/** A release record that is new at the release commit relative to its first parent. */
export interface BatchMember {
	readonly key: string;
	readonly name: string;
	readonly version: string;
	readonly dirName: string;
	readonly record: LedgerRecord;
}

/** A batch member whose manifest, consumed intents, and changelog section were validated. */
export interface PreparedMember extends BatchMember {
	readonly notes: string;
}

/** A record removed by a withdrawal, as it was at the withdrawal commit's first parent. */
export interface WithdrawnRecord extends ReleaseKey {
	readonly key: string;
	readonly record: LedgerRecord;
}

export type Transition =
	| { readonly kind: "unchanged" }
	| { readonly kind: "release"; readonly members: readonly BatchMember[] }
	| { readonly kind: "withdrawal"; readonly removed: readonly WithdrawnRecord[] };

export type EndpointResult = { readonly kind: "no-op"; readonly reason: string } | { readonly kind: "changed" };

export interface PushUpdate {
	readonly before: string;
	readonly after: string;
	readonly forced: boolean;
	readonly parents: readonly string[];
}

export interface PullRequest {
	readonly number: number;
	readonly merged: boolean;
	readonly mergeCommitSha: string | null;
	readonly baseRef: string;
}

/** Evidence read at the release commit (manifest, changelog) and its first parent (intents, ledger). */
export interface MemberEvidence {
	readonly manifest: PluginManifest | undefined;
	readonly changelog: string | undefined;
	readonly parentIntents: ReadonlyMap<string, ChangeIntent | undefined>;
	/** Intent ids the parent ledger already records as consumed by this plugin. */
	readonly consumedAtParent: ReadonlySet<string>;
}

/** Evidence read at a withdrawal commit for one removed record. */
export interface WithdrawalEvidence {
	readonly ledger: Ledger;
	readonly manifest: PluginManifest | undefined;
	readonly changelog: string | undefined;
	readonly intents: ReadonlyMap<string, ChangeIntent | undefined>;
}

function keyParts(key: string): ReleaseKey {
	const parts = splitReleaseKey(key);
	if (parts === undefined) {
		throw new ReleaseError(`"${key}" is not "<name>@<version>"`);
	}
	return parts;
}

/**
 * Push endpoints decide only whether release work must be evaluated: identical records are a
 * successful no-op, an initial push (no prior tip) may not carry records, and any change goes
 * on to the first-parent boundary check. This never selects a batch.
 */
export function compareEndpoints(before: Ledger | undefined, after: Ledger): EndpointResult {
	if (before === undefined) {
		if (after.size === 0) {
			return { kind: "no-op", reason: "initial push without release records" };
		}
		throw new ReleaseError(
			"the initial push already contains release records; publication only follows a pull request merged onto an existing default branch",
		);
	}
	return sameLedger(before, after)
		? { kind: "no-op", reason: "release records are identical at both push endpoints" }
		: { kind: "changed" };
}

/** A record-changing push must be exactly one normal integration whose first parent is the prior tip. */
export function boundaryProblems(push: PushUpdate): string[] {
	const problems: string[] = [];
	if (push.forced) {
		problems.push("the push was forced");
	}
	const [firstParent] = push.parents;
	if (firstParent === undefined) {
		problems.push(`${push.after} has no parent`);
	} else if (push.parents.length > 2) {
		problems.push(
			`${push.after} has ${push.parents.length} parents; only squash or two-parent merge commits are supported`,
		);
	} else if (firstParent !== push.before) {
		problems.push(
			`the prior tip ${push.before} is not the first parent ${firstParent} of ${push.after}: the push carried more than one integration (rebase merge, batched merge, or direct push)`,
		);
	}
	return problems;
}

/**
 * The pull request whose squash or merge commit is the release commit on the default branch.
 * GitHub also reports the last commit of a rebase merge as the merge commit; a rebase is
 * recognized by a first parent that belongs to the same pull request.
 */
export function findIntegration(
	sourceSha: string,
	defaultBranch: string,
	parents: readonly string[],
	pulls: readonly PullRequest[],
	firstParentPulls: readonly PullRequest[],
): PullRequest {
	if (parents.length < 1 || parents.length > 2) {
		throw new ReleaseError(`${sourceSha} has ${parents.length} parents; a release commit is a squash or merge commit`);
	}
	const pull = pulls.find((pr) => pr.merged && pr.mergeCommitSha === sourceSha && pr.baseRef === defaultBranch);
	if (pull === undefined) {
		throw new ReleaseError(
			`${sourceSha} is not the squash or merge commit of a pull request merged into ${defaultBranch}`,
		);
	}
	if (firstParentPulls.some((pr) => pr.number === pull.number)) {
		throw new ReleaseError(
			`${sourceSha} and its first parent both come from pull request #${pull.number}: a rebase merge, which is not a supported integration`,
		);
	}
	return pull;
}

/**
 * Classifies the ledger change between a release commit's first parent and the commit.
 * Records are append-only: modifications, and removals mixed with additions, are protocol
 * failures. Pure removal is a withdrawal candidate that the caller must still guard.
 */
export function classifyTransition(parent: Ledger, source: Ledger): Transition {
	const diff = diffLedgers(parent, source);
	if (diff.changed.length > 0) {
		throw new ReleaseError(
			`existing release records were modified: ${diff.changed.join(", ")}; prepared records are append-only`,
		);
	}
	if (diff.added.length > 0 && diff.removed.length > 0) {
		throw new ReleaseError(
			`one commit adds (${diff.added.join(", ")}) and removes (${diff.removed.join(", ")}) release records; withdraw and prepare again in separate pull requests`,
		);
	}
	if (diff.removed.length > 0) {
		const removed: WithdrawnRecord[] = [];
		for (const key of diff.removed) {
			const record = parent.get(key);
			if (record !== undefined) {
				removed.push({ key, ...keyParts(key), record });
			}
		}
		return { kind: "withdrawal", removed };
	}
	if (diff.added.length === 0) {
		return { kind: "unchanged" };
	}
	const problems: string[] = [];
	const members: BatchMember[] = [];
	for (const key of diff.added) {
		const record = source.get(key);
		if (record === undefined) {
			continue;
		}
		const { name, version } = keyParts(key);
		const dirName = dirNameOfPlugin(name);
		if (dirName === undefined) {
			problems.push(`${key}: only @zeroclover/<package> plugins are released`);
		} else if (record.dir === null || pluginDirName(record.dir) !== dirName) {
			problems.push(`${key}: the record's dir "${record.dir ?? "(none)"}" must be ${pluginDir(dirName)}`);
		} else if (record.intents.length === 0) {
			problems.push(`${key}: the record consumed no change intent; only changeset-backed preparations release`);
		} else {
			members.push({ key, name, version, dirName, record });
		}
	}
	if (problems.length > 0) {
		throw new ReleaseError(problems.join("\n"));
	}
	return { kind: "release", members };
}

/** Validates one member against the release commit and its parent; returns its exact release notes. */
export function validateMember(member: BatchMember, evidence: MemberEvidence): PreparedMember {
	const problems: string[] = [];
	const dir = pluginDir(member.dirName);
	const { manifest } = evidence;
	if (manifest === undefined) {
		problems.push(`${dir}/package.json does not exist`);
	} else {
		problems.push(...identityProblems(member.dirName, manifest));
		if (manifest.version !== member.version) {
			problems.push(`${dir}/package.json has version ${manifest.version ?? "(none)"}, not ${member.version}`);
		}
	}
	for (const id of member.record.intents) {
		const intent = evidence.parentIntents.get(id);
		const bump = intent === undefined ? undefined : bumpFor(intent, { name: member.name, dir });
		if (evidence.consumedAtParent.has(id)) {
			problems.push(`consumed intent "${id}" had already been consumed by ${member.name} before this preparation`);
		} else if (bump === undefined || bump === "none") {
			problems.push(`consumed intent "${id}" was not a pending release intent for ${member.name} at the parent commit`);
		}
	}
	let notes = "";
	if (evidence.changelog === undefined) {
		problems.push(`${dir}/CHANGELOG.md does not exist`);
	} else {
		try {
			notes = releaseNotes(evidence.changelog, member.version, `${dir}/CHANGELOG.md`);
		} catch (error) {
			problems.push(errorMessage(error));
		}
	}
	if (problems.length > 0) {
		throw new ReleaseError(problems.map((problem) => `${member.key}: ${problem}`).join("\n"));
	}
	return { ...member, notes };
}

/**
 * Manifest versions change only through native preparation (a new record of the new version) or
 * its withdrawal (removal of the record of the old version). Anything else is a manual edit or a
 * dependency-propagated bump without its own change intent.
 */
export function unpreparedVersionChanges(
	parent: ReadonlyMap<string, PluginManifest>,
	source: ReadonlyMap<string, PluginManifest>,
	preparedKeys: ReadonlySet<string>,
	withdrawnKeys: ReadonlySet<string> = new Set(),
): string[] {
	const problems: string[] = [];
	for (const [dirName, manifest] of source) {
		const before = parent.get(dirName);
		if (before === undefined || before.version === manifest.version) {
			continue;
		}
		const name = manifest.name ?? "";
		if (
			!preparedKeys.has(`${name}@${manifest.version ?? ""}`) &&
			!withdrawnKeys.has(`${name}@${before.version ?? ""}`)
		) {
			problems.push(
				`${pluginDir(dirName)}/package.json: version ${before.version ?? "(none)"} -> ${manifest.version ?? "(none)"} without a release record of that version; versions change only through pnpm version -r, and every released package needs its own change intent`,
			);
		}
	}
	return problems;
}

/**
 * A withdrawal must restore the withdrawn preparation's pending state at the withdrawal commit:
 * every consumed intent is a pending release intent for the plugin again, the version's changelog
 * section is gone, and the manifest is back at the version before the preparation. Versions change
 * only through release records, so that is the plugin's highest remaining released version, or the
 * withdrawn version itself for a first release, which pnpm prepares without changing the version.
 */
export function withdrawalProblems(removed: WithdrawnRecord, evidence: WithdrawalEvidence): string[] {
	const dirName = dirNameOfPlugin(removed.name);
	if (dirName === undefined || removed.record.dir === null || pluginDirName(removed.record.dir) !== dirName) {
		return [`${removed.key}: only records of @zeroclover/<package> plugins in packages/<package> can be withdrawn`];
	}
	const pkg = { name: removed.name, dir: pluginDir(dirName) };
	const consumed = consumedBy(evidence.ledger, pkg);
	const problems: string[] = [];
	for (const id of removed.record.intents) {
		const intent = evidence.intents.get(id);
		const bump = intent === undefined ? undefined : bumpFor(intent, pkg);
		if (bump === undefined || bump === "none" || consumed.has(id)) {
			problems.push(`intent "${id}" is not restored as a pending release intent for ${removed.name}`);
		}
	}
	if (evidence.changelog !== undefined && releaseSectionCount(evidence.changelog, removed.version) > 0) {
		problems.push(`${pkg.dir}/CHANGELOG.md still has the "## ${removed.version}" section`);
	}
	const remaining = [...evidence.ledger.keys()].flatMap((key) => {
		const parts = splitReleaseKey(key);
		return parts?.name === removed.name ? [parts.version] : [];
	});
	const expected = remaining.sort(rcompare)[0] ?? removed.version;
	if (evidence.manifest?.version !== expected) {
		problems.push(
			`${pkg.dir}/package.json has version ${evidence.manifest?.version ?? "(none)"}; the withdrawal must restore ${expected}, the version before the withdrawn preparation`,
		);
	}
	return problems.map((problem) => `${removed.key}: ${problem}`);
}

/**
 * Batch members in publication order: every member after the batch members whose released version
 * it installs, so a dependent never becomes installable before its dependency; ties by key. A
 * dependency on another version of a member is no edge. A cycle cannot be published in order.
 */
export function publicationOrder<T extends BatchMember>(
	members: readonly T[],
	manifests: ReadonlyMap<string, PluginManifest>,
): T[] {
	const byName = new Map(members.map((member) => [member.name, member]));
	const dependencies = (member: T): string[] => {
		const manifest = manifests.get(member.dirName);
		return members
			.filter(
				(other) => other !== member && manifest !== undefined && dependsOnVersion(manifest, other.name, other.version),
			)
			.map((other) => other.name)
			.sort();
	};
	const ordered: T[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (member: T, path: readonly string[]): void => {
		const seen = state.get(member.name);
		if (seen === "done") {
			return;
		}
		if (seen === "visiting") {
			throw new ReleaseError(`batch members depend on each other in a cycle: ${[...path, member.name].join(" -> ")}`);
		}
		state.set(member.name, "visiting");
		for (const name of dependencies(member)) {
			const dependency = byName.get(name);
			if (dependency !== undefined) {
				visit(dependency, [...path, member.name]);
			}
		}
		state.set(member.name, "done");
		ordered.push(member);
	};
	for (const member of [...members].sort((a, b) => a.key.localeCompare(b.key))) {
		visit(member, []);
	}
	return ordered;
}
