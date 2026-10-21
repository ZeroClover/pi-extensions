import type { LedgerSnapshot } from "./authorization.ts";
import {
	type BatchMember,
	classifyTransition,
	type PreparedMember,
	publicationOrder,
	unpreparedVersionChanges,
	validateMember,
	type WithdrawnRecord,
	withdrawalProblems,
} from "./batch.ts";
import { changelogPath } from "./changelog.ts";
import { errorMessage, ReleaseError } from "./errors.ts";
import type { Git } from "./git.ts";
import { type ChangeIntent, intentPath, parseIntent } from "./intents.ts";
import { consumedBy, LEDGER_PATH, type Ledger, parseLedger } from "./ledger.ts";
import { PACKAGES_DIR, type PluginManifest, parseManifest, pluginDir, pluginDirName } from "./manifest.ts";

/** What a commit does to the release records relative to its first parent. */
export type ReleaseBatch =
	| {
			readonly kind: "release";
			readonly source: string;
			readonly parent: string;
			readonly members: readonly PreparedMember[];
	  }
	| {
			readonly kind: "withdrawal";
			readonly source: string;
			readonly parent: string;
			readonly removed: readonly WithdrawnRecord[];
	  }
	| { readonly kind: "unchanged"; readonly source: string; readonly parent: string };

/** Release state read from committed snapshots; parsed ledgers are cached by blob id for one run. */
export class ReleaseRepository {
	readonly git: Git;
	readonly #ledgers = new Map<string, Ledger>();

	constructor(git: Git) {
		this.git = git;
	}

	async #ledgerBlob(id: string | undefined, where: string): Promise<Ledger> {
		if (id === undefined) {
			return new Map();
		}
		const cached = this.#ledgers.get(id);
		if (cached !== undefined) {
			return cached;
		}
		const ledger = parseLedger(await this.git.readBlob(id), where);
		this.#ledgers.set(id, ledger);
		return ledger;
	}

	async ledgerAt(commit: string): Promise<Ledger> {
		return this.#ledgerBlob(await this.git.blobId(commit, LEDGER_PATH), `${LEDGER_PATH} at ${commit}`);
	}

	async manifestAt(commit: string, dirName: string): Promise<PluginManifest | undefined> {
		const path = `${pluginDir(dirName)}/package.json`;
		const text = await this.git.readFile(commit, path);
		return text === undefined ? undefined : parseManifest(text, `${path} at ${commit}`);
	}

	/** Plugin manifests by directory name: every `packages/<name>/package.json` at the commit. */
	async manifestsAt(commit: string): Promise<Map<string, PluginManifest>> {
		const manifests = new Map<string, PluginManifest>();
		for (const dirName of await this.git.entries(commit, PACKAGES_DIR, "tree")) {
			const manifest = await this.manifestAt(commit, dirName);
			if (manifest !== undefined) {
				manifests.set(dirName, manifest);
			}
		}
		return manifests;
	}

	async intentAt(commit: string, id: string): Promise<ChangeIntent | undefined> {
		const text = await this.git.readFile(commit, intentPath(id));
		return text === undefined ? undefined : parseIntent(id, text, `${intentPath(id)} at ${commit}`);
	}

	/** Validates members against the release snapshot and its parent, collecting every problem. */
	async prepareMembers(
		members: readonly BatchMember[],
		source: string,
		parent: string,
	): Promise<{ readonly prepared: PreparedMember[]; readonly problems: string[] }> {
		const prepared: PreparedMember[] = [];
		const problems: string[] = [];
		const parentLedger = await this.ledgerAt(parent);
		for (const member of members) {
			try {
				const parentIntents = new Map<string, ChangeIntent | undefined>();
				for (const id of member.record.intents) {
					parentIntents.set(id, await this.intentAt(parent, id));
				}
				const dir = pluginDir(member.dirName);
				const evidence = {
					manifest: await this.manifestAt(source, member.dirName),
					changelog: await this.git.readFile(source, changelogPath(dir)),
					parentIntents,
					consumedAtParent: consumedBy(parentLedger, { name: member.name, dir }),
				};
				prepared.push(validateMember(member, evidence));
			} catch (error) {
				problems.push(errorMessage(error));
			}
		}
		return { prepared, problems };
	}

	/** Checks that `source` restores the pending state of every withdrawn record. */
	async withdrawalProblems(removed: readonly WithdrawnRecord[], source: string): Promise<string[]> {
		const ledger = await this.ledgerAt(source);
		const problems: string[] = [];
		for (const record of removed) {
			try {
				const intents = new Map<string, ChangeIntent | undefined>();
				for (const id of record.record.intents) {
					intents.set(id, await this.intentAt(source, id));
				}
				const dirName = record.record.dir === null ? undefined : pluginDirName(record.record.dir);
				const evidence = {
					ledger,
					manifest: dirName === undefined ? undefined : await this.manifestAt(source, dirName),
					changelog:
						dirName === undefined ? undefined : await this.git.readFile(source, changelogPath(pluginDir(dirName))),
					intents,
				};
				problems.push(...withdrawalProblems(record, evidence));
			} catch (error) {
				problems.push(errorMessage(error));
			}
		}
		return problems;
	}

	/**
	 * The fixed-parent batch: release records new in `source` relative to its first parent, fully
	 * validated and in publication order. History beyond that one parent is never consulted. A
	 * withdrawal is returned only when it restores the withdrawn pending state. `against` replaces
	 * the first parent only for the pull request preflight, which reads the batch from its merge base.
	 */
	async readBatch(source: string, against?: string): Promise<ReleaseBatch> {
		const parent = against ?? (await this.git.parents(source))[0];
		if (parent === undefined) {
			throw new ReleaseError(`${source} has no parent`);
		}
		const transition = classifyTransition(await this.ledgerAt(parent), await this.ledgerAt(source));
		if (transition.kind === "unchanged") {
			return { kind: "unchanged", source, parent };
		}
		const parentManifests = await this.manifestsAt(parent);
		const sourceManifests = await this.manifestsAt(source);
		if (transition.kind === "withdrawal") {
			const withdrawn = new Set(transition.removed.map((record) => record.key));
			const problems = [
				...(await this.withdrawalProblems(transition.removed, source)),
				...unpreparedVersionChanges(parentManifests, sourceManifests, new Set(), withdrawn),
			];
			if (problems.length > 0) {
				throw new ReleaseError(`the withdrawal in ${source} is invalid:\n${problems.join("\n")}`);
			}
			return { kind: "withdrawal", source, parent, removed: transition.removed };
		}
		const { prepared, problems } = await this.prepareMembers(transition.members, source, parent);
		const keys = new Set(transition.members.map((member) => member.key));
		problems.push(...unpreparedVersionChanges(parentManifests, sourceManifests, keys));
		if (problems.length > 0) {
			throw new ReleaseError(`the release batch of ${source} is invalid:\n${problems.join("\n")}`);
		}
		return { kind: "release", source, parent, members: publicationOrder(prepared, sourceManifests) };
	}

	/**
	 * Ledger states on the default branch's first-parent history after `source`: one snapshot per
	 * ledger-changing commit, in order, so intermediate removals and mutations stay visible.
	 */
	async snapshotsAfter(source: string, commits: readonly string[]): Promise<LedgerSnapshot[]> {
		const ids = await this.git.blobIds([source, ...commits], LEDGER_PATH);
		let previous = ids.get(source);
		const snapshots: LedgerSnapshot[] = [];
		for (const commit of commits) {
			const id = ids.get(commit);
			if (id === previous) {
				continue;
			}
			previous = id;
			snapshots.push({ commit, ledger: await this.#ledgerBlob(id, `${LEDGER_PATH} at ${commit}`) });
		}
		return snapshots;
	}
}
