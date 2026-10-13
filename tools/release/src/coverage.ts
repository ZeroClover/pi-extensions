import { bumpFor, type ChangeIntent } from "./intents.ts";
import { isPublishedPath, type PluginManifest, pluginDir, pluginName } from "./manifest.ts";

export interface PluginAtHead {
	readonly dirName: string;
	readonly manifest: PluginManifest;
}

export interface CoverageInput {
	/** Repository paths changed between the merge base and the pull request head. */
	readonly changedPaths: readonly string[];
	/** Plugins that exist at the head. */
	readonly plugins: readonly PluginAtHead[];
	/** Base versions of the changed intent files; a missing id is new in this pull request. */
	readonly baseIntents: ReadonlyMap<string, ChangeIntent>;
	/** Head versions of the changed intent files; a missing id was deleted (consumed). */
	readonly headIntents: ReadonlyMap<string, ChangeIntent>;
	/** Names of plugins with new, validated release records in this pull request. */
	readonly prepared: ReadonlySet<string>;
	/** Validated withdrawals in this pull request: plugin name -> withdrawn release key. */
	readonly withdrawn: ReadonlyMap<string, string>;
	/** Intent ids the merge-base ledger records as consumed, per plugin name. */
	readonly consumed: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface PluginCoverage {
	readonly name: string;
	readonly dirName: string;
	readonly changed: readonly string[];
	/** How the pull request decided this plugin's release impact; undefined when it did not. */
	readonly decision: string | undefined;
}

/**
 * The release-impact gate: every plugin whose published content changed needs a decision
 * contributed by this pull request: an added or meaningfully updated intent with a summary (a
 * positive bump or a reasoned none), a new prepared release record, or a validated withdrawal.
 * An intent already pending on the base branch never counts, and neither does a shared intent
 * that this plugin has already consumed.
 */
export function evaluateCoverage(input: CoverageInput): PluginCoverage[] {
	const results: PluginCoverage[] = [];
	for (const { dirName, manifest } of input.plugins) {
		const prefix = `${pluginDir(dirName)}/`;
		const changed = input.changedPaths.filter(
			(path) => path.startsWith(prefix) && isPublishedPath(manifest, path.slice(prefix.length)),
		);
		if (changed.length === 0) {
			continue;
		}
		const name = pluginName(dirName);
		results.push({ name, dirName, changed, decision: decide(input, { name, dir: pluginDir(dirName) }) });
	}
	return results;
}

function decide(input: CoverageInput, pkg: { readonly name: string; readonly dir: string }): string | undefined {
	if (input.prepared.has(pkg.name)) {
		return "prepared release record";
	}
	const withdrawn = input.withdrawn.get(pkg.name);
	if (withdrawn !== undefined) {
		return `withdrawal of ${withdrawn}`;
	}
	const consumed = input.consumed.get(pkg.name);
	const decisions: string[] = [];
	for (const [id, intent] of input.headIntents) {
		const bump = bumpFor(intent, pkg);
		if (bump === undefined || intent.summary === "" || consumed?.has(id) === true) {
			continue;
		}
		const base = input.baseIntents.get(id);
		if (base === undefined || bumpFor(base, pkg) !== bump || base.summary !== intent.summary) {
			decisions.push(`${bump === "none" ? "no release" : `${bump} release`} (.changeset/${id}.md)`);
		}
	}
	return decisions.length > 0 ? decisions.join(", ") : undefined;
}
