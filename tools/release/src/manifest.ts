import { satisfies } from "semver";
import { errorMessage, field, isRecord, isStringArray, ReleaseError } from "./errors.ts";
import { isSemver, normalizeProjectDir } from "./ledger.ts";

/** Every plugin publishes as `@zeroclover/<directory name>` from `packages/<directory name>/`. */
export const SCOPE = "@zeroclover";
export const PACKAGES_DIR = "packages";

/** Supplied by Pi at runtime: peer dependencies with range "*", never bundled. */
export const HOST_PACKAGES: readonly string[] = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

export interface PluginManifest {
	readonly name: string | undefined;
	readonly version: string | undefined;
	readonly private: boolean;
	readonly files: readonly string[] | undefined;
	readonly data: Readonly<Record<string, unknown>>;
}

export function parseManifest(text: string, source: string): PluginManifest {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new ReleaseError(`${source}: invalid JSON: ${errorMessage(error)}`);
	}
	if (!isRecord(data)) {
		throw new ReleaseError(`${source}: expected a JSON object`);
	}
	const { name, version, files, private: isPrivate } = data;
	return {
		name: typeof name === "string" ? name : undefined,
		version: typeof version === "string" ? version : undefined,
		private: isPrivate === true,
		files: isStringArray(files) ? files : undefined,
		data,
	};
}

export function pluginName(dirName: string): string {
	return `${SCOPE}/${dirName}`;
}

export function pluginDir(dirName: string): string {
	return `${PACKAGES_DIR}/${dirName}`;
}

/** The directory name of a `packages/<name>` path, or undefined for any other directory. */
export function pluginDirName(dir: string): string | undefined {
	const match = /^packages\/([^/]+)$/.exec(normalizeProjectDir(dir));
	return match?.[1];
}

/** The directory name a `@zeroclover/<name>` package must live in, or undefined for other names. */
export function dirNameOfPlugin(name: string): string | undefined {
	const prefix = `${SCOPE}/`;
	const rest = name.startsWith(prefix) ? name.slice(prefix.length) : "";
	return /^[a-z0-9][a-z0-9._-]*$/.test(rest) ? rest : undefined;
}

/** Characters that make a path a pattern: globs and `!` exclusions. */
export const GLOB = /[*?[\]{}!]/;

/** The `pi` manifest resource kinds a package can declare. */
export const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"] as const;

/** Every declared `pi` resource entry as [kind, entry]; non-string entries are reported as problems. */
export function piResources(manifest: PluginManifest): {
	readonly entries: [string, string][];
	readonly problems: string[];
} {
	const { pi } = manifest.data;
	const entries: [string, string][] = [];
	const problems: string[] = [];
	if (!isRecord(pi)) {
		return { entries, problems: ['"pi" must declare the package\'s resources'] };
	}
	for (const kind of RESOURCE_KINDS) {
		const declared = field(pi, kind);
		if (declared === undefined) {
			continue;
		}
		if (!isStringArray(declared)) {
			problems.push(`pi.${kind} must be a list of paths`);
			continue;
		}
		for (const entry of declared) {
			entries.push([kind, entry]);
		}
	}
	return { entries, problems };
}

/** Problems with a plugin's identity and the manifest fields the release tooling relies on. */
export function identityProblems(dirName: string, manifest: PluginManifest): string[] {
	const where = `${pluginDir(dirName)}/package.json`;
	const problems: string[] = [];
	if (manifest.name !== pluginName(dirName)) {
		problems.push(`${where}: name must be "${pluginName(dirName)}", found "${manifest.name ?? "(none)"}"`);
	}
	if (manifest.private) {
		problems.push(`${where}: plugins are published; remove "private": true`);
	}
	if (manifest.version === undefined || !isSemver(manifest.version)) {
		problems.push(`${where}: version must be a semver version`);
	}
	if (manifest.files === undefined) {
		problems.push(`${where}: "files" must list the published paths`);
	} else {
		for (const entry of manifest.files) {
			if (GLOB.test(entry)) {
				problems.push(`${where}: files entry "${entry}" uses a glob or negation; list plain paths`);
			}
		}
		if (!manifest.files.map(normalizeProjectDir).includes("CHANGELOG.md")) {
			problems.push(`${where}: "files" must include CHANGELOG.md`);
		}
	}
	const { publishConfig } = manifest.data;
	if (field(publishConfig, "access") !== "public") {
		problems.push(`${where}: publishConfig.access must be "public" (scoped packages are private on npm by default)`);
	}
	const resources = piResources(manifest);
	problems.push(...resources.problems.map((problem) => `${where}: ${problem}`));
	for (const [kind, entry] of resources.entries) {
		if (GLOB.test(entry)) {
			problems.push(
				`${where}: pi.${kind} entry "${entry}" is a pattern; list plain paths so releases can verify every resource`,
			);
		} else if (!isPublishedPath(manifest, normalizeProjectDir(entry))) {
			problems.push(`${where}: pi.${kind} entry "${entry}" is outside "files", so it would not be published`);
		}
	}
	return problems;
}

/** Dependency fields that installing a package resolves; peers are left to the host, as Pi installs packages. */
const INSTALLED_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];

/**
 * Whether the manifest's installed dependency on `name` resolves to `version` once that version is
 * published. `workspace:*`, `workspace:^`, and `workspace:~` name the current workspace version;
 * other `workspace:` specs carry their range; anything else is an ordinary range.
 */
export function dependsOnVersion(manifest: PluginManifest, name: string, version: string): boolean {
	return INSTALLED_DEPENDENCY_FIELDS.some((fieldName) => {
		const spec = field(manifest.data[fieldName], name);
		if (typeof spec !== "string") {
			return false;
		}
		const workspace = spec.startsWith("workspace:") ? spec.slice("workspace:".length) : undefined;
		const range = workspace === undefined ? spec : ["", "*", "^", "~"].includes(workspace) ? version : workspace;
		return satisfies(version, range);
	});
}

const ALWAYS_PACKED = /^(?:package\.json|(?:readme|license|licence)(?:\.[^/]*)?)$/i;

/** Whether a path inside a package directory is part of its published content. */
export function isPublishedPath(manifest: PluginManifest, path: string): boolean {
	if (ALWAYS_PACKED.test(path)) {
		return true;
	}
	return (manifest.files ?? []).some((entry) => {
		const root = normalizeProjectDir(entry);
		return path === root || path.startsWith(`${root}/`);
	});
}
