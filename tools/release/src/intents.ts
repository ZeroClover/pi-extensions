import { parse } from "yaml";
import { errorMessage, isRecord, ReleaseError } from "./errors.ts";
import { normalizeProjectDir } from "./ledger.ts";

export type BumpType = "none" | "patch" | "minor" | "major";

/** One `.changeset/<id>.md` change intent, parsed with pnpm's rules. */
export interface ChangeIntent {
	readonly id: string;
	readonly releases: ReadonlyMap<string, BumpType>;
	readonly summary: string;
}

const BUMPS: ReadonlySet<string> = new Set(["none", "patch", "minor", "major"]);

function isBump(value: unknown): value is BumpType {
	return typeof value === "string" && BUMPS.has(value);
}

/** The intent id of a repository path, or undefined when pnpm would not read it as an intent. */
export function intentIdOf(path: string): string | undefined {
	const id = /^\.changeset\/([^/]+)\.md$/.exec(path)?.[1];
	return id === undefined || id.toLowerCase() === "readme" ? undefined : id;
}

export function intentPath(id: string): string {
	return `.changeset/${id}.md`;
}

export function parseIntent(id: string, text: string, source: string): ChangeIntent {
	const lines = text
		.replace(/^\uFEFF/, "")
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const closing = lines[0]?.trim() === "---" ? lines.findIndex((line, i) => i > 0 && line.trim() === "---") : -1;
	if (closing === -1) {
		throw new ReleaseError(`${source}: missing "---" front matter`);
	}
	const frontMatter = lines.slice(1, closing).join("\n");
	let parsed: unknown = {};
	if (frontMatter.trim() !== "") {
		try {
			parsed = parse(frontMatter, { uniqueKeys: true, prettyErrors: false });
		} catch (error) {
			throw new ReleaseError(`${source}: invalid front matter: ${errorMessage(error)}`);
		}
	}
	if (!isRecord(parsed)) {
		throw new ReleaseError(`${source}: front matter must map package names to bump types`);
	}
	const releases = new Map<string, BumpType>();
	for (const [reference, bump] of Object.entries(parsed)) {
		if (!isBump(bump)) {
			throw new ReleaseError(`${source}: "${reference}" has bump "${String(bump)}"; use none, patch, minor, or major`);
		}
		releases.set(reference, bump);
	}
	return {
		id,
		releases,
		summary: lines
			.slice(closing + 1)
			.join("\n")
			.trim(),
	};
}

/** The bump an intent declares for a package, referenced by full name or `./<dir>`. */
export function bumpFor(
	intent: ChangeIntent,
	pkg: { readonly name: string; readonly dir: string },
): BumpType | undefined {
	for (const [reference, bump] of intent.releases) {
		if (reference === pkg.name || (reference.startsWith("./") && normalizeProjectDir(reference) === pkg.dir)) {
			return bump;
		}
	}
	return undefined;
}
