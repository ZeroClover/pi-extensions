import { parse } from "yaml";
import { errorMessage, isRecord, isStringArray, ReleaseError } from "./errors.ts";

/** pnpm's committed, append-only record of prepared releases. */
export const LEDGER_PATH = ".changeset/ledger.yaml";

/**
 * One prepared release as pnpm records it: the released project directory (null for the
 * bare id-list shape) and the ids of the change intents it consumed, sorted and unique.
 */
export interface LedgerRecord {
	readonly dir: string | null;
	readonly intents: readonly string[];
}

/** Records keyed by `<package name>@<version>`. */
export type Ledger = ReadonlyMap<string, LedgerRecord>;

export interface ReleaseKey {
	readonly name: string;
	readonly version: string;
}

export interface LedgerDiff {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly changed: readonly string[];
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isSemver(version: string): boolean {
	return SEMVER.test(version);
}

/** Splits `name@version` on the last `@`; the leading `@` of a scope is not a separator. */
export function splitReleaseKey(key: string): ReleaseKey | undefined {
	const at = key.lastIndexOf("@");
	if (at <= 0) {
		return undefined;
	}
	const name = key.slice(0, at);
	const version = key.slice(at + 1);
	return isSemver(version) ? { name, version } : undefined;
}

export function releaseKey(name: string, version: string): string {
	return `${name}@${version}`;
}

/** pnpm's canonical project directory: forward slashes, no leading `./`, no trailing slash. */
export function normalizeProjectDir(dir: string): string {
	let normalized = dir.replaceAll("\\", "/");
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	return normalized.replace(/\/+$/, "");
}

/**
 * Parses ledger YAML into structured records. Formatting (quoting, indentation, flow or
 * block style, intent order) does not survive parsing; any shape pnpm would not write or
 * read is an error rather than an empty or partial ledger.
 */
export function parseLedger(text: string, source: string): Ledger {
	if (text.trim() === "") {
		return new Map();
	}
	let document: unknown;
	try {
		document = parse(text, { uniqueKeys: true, prettyErrors: false });
	} catch (error) {
		throw new ReleaseError(`${source}: invalid YAML: ${errorMessage(error)}`);
	}
	if (document === null || document === undefined) {
		return new Map();
	}
	if (!isRecord(document)) {
		throw new ReleaseError(`${source}: expected a mapping of "<name>@<version>" keys`);
	}
	const ledger = new Map<string, LedgerRecord>();
	for (const [key, value] of Object.entries(document)) {
		if (splitReleaseKey(key) === undefined) {
			throw new ReleaseError(`${source}: key "${key}" is not "<name>@<semver>"`);
		}
		ledger.set(key, parseRecord(value, `${source}: "${key}"`));
	}
	return ledger;
}

function parseRecord(value: unknown, where: string): LedgerRecord {
	if (value === null) {
		return { dir: null, intents: [] };
	}
	if (Array.isArray(value)) {
		return { dir: null, intents: intentIds(value, where) };
	}
	if (!isRecord(value)) {
		throw new ReleaseError(`${where}: expected a list of intent ids or a mapping with "dir" and "intents"`);
	}
	const unexpected = Object.keys(value).filter((field) => field !== "dir" && field !== "intents");
	if (unexpected.length > 0) {
		throw new ReleaseError(`${where}: unexpected field(s) ${unexpected.join(", ")}`);
	}
	const { dir, intents } = value;
	if (typeof dir !== "string" || normalizeProjectDir(dir) === "") {
		throw new ReleaseError(`${where}: "dir" must be a workspace-relative directory`);
	}
	return {
		dir: normalizeProjectDir(dir),
		intents: intents === undefined || intents === null ? [] : intentIds(intents, where),
	};
}

function intentIds(value: unknown, where: string): string[] {
	if (!isStringArray(value) || value.some((id) => id === "")) {
		throw new ReleaseError(`${where}: intents must be a list of non-empty intent ids`);
	}
	return [...new Set(value)].sort();
}

export function sameRecord(a: LedgerRecord, b: LedgerRecord): boolean {
	return a.dir === b.dir && a.intents.length === b.intents.length && a.intents.every((id, i) => id === b.intents[i]);
}

export function diffLedgers(before: Ledger, after: Ledger): LedgerDiff {
	const added: string[] = [];
	const changed: string[] = [];
	for (const [key, record] of after) {
		const previous = before.get(key);
		if (previous === undefined) {
			added.push(key);
		} else if (!sameRecord(previous, record)) {
			changed.push(key);
		}
	}
	const removed = [...before.keys()].filter((key) => !after.has(key));
	return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Intent ids the ledger records as consumed by one project, as pnpm attributes them: by the
 * record's dir, or by package name for the bare id-list shape. A shared intent file can outlive
 * this consumption while another project still needs it.
 */
export function consumedBy(ledger: Ledger, pkg: { readonly name: string; readonly dir: string }): Set<string> {
	const consumed = new Set<string>();
	for (const [key, record] of ledger) {
		const owner = record.dir ?? (splitReleaseKey(key)?.name === pkg.name ? pkg.dir : undefined);
		if (owner === pkg.dir) {
			for (const id of record.intents) {
				consumed.add(id);
			}
		}
	}
	return consumed;
}

export function sameLedger(a: Ledger, b: Ledger): boolean {
	const diff = diffLedgers(a, b);
	return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
