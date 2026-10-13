import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type { PreparedMember } from "./batch.ts";
import { releaseNotes } from "./changelog.ts";
import { errorMessage, field, isRecord, ReleaseError } from "./errors.ts";
import { type Runner, runChecked } from "./exec.ts";
import { normalizeProjectDir } from "./ledger.ts";
import {
	dependsOnVersion,
	GLOB,
	HOST_PACKAGES,
	type PluginManifest,
	parseManifest,
	piResources,
	pluginDir,
} from "./manifest.ts";
import { sha256 } from "./publish.ts";

export interface VerifyContext {
	readonly run: Runner;
	/** Checkout of the release commit with its dependencies installed. */
	readonly sourceDir: string;
	/** Where validated tarballs are written. */
	readonly outDir: string;
	/** Scratch space outside the workspace for isolated installs and Pi agent directories. */
	readonly workDir: string;
	/** The targeted Pi host: the release commit's own `node_modules/.bin/pi`. */
	readonly hostBin: string;
}

export interface VerifiedArtifact {
	readonly key: string;
	readonly file: string;
	readonly sha256: string;
	readonly commands: readonly string[];
}

const REQUIRED_FILES = ["package.json", "README.md", "CHANGELOG.md", "LICENSE"];
const DEVELOPMENT_FILE = /^package\/(?:test|tests|openspec|node_modules)\/|\.test\.ts$/;

function dependencies(manifest: PluginManifest, field: string): Record<string, unknown> {
	const value = manifest.data[field];
	return isRecord(value) ? value : {};
}

/**
 * Problems with a packed tarball's file list, manifest, and changelog section. `sourceFiles` are the
 * package's committed files (relative to the package): every file of a declared resource, or under a
 * declared resource directory, must be packed.
 */
export function tarballProblems(
	member: PreparedMember,
	entries: readonly string[],
	manifest: PluginManifest,
	changelog: string | undefined,
	sourceFiles: readonly string[],
): string[] {
	const problems: string[] = [];
	const packed = (path: string): boolean =>
		entries.some((entry) => entry === `package/${path}` || entry.startsWith(`package/${path}/`));
	for (const file of REQUIRED_FILES) {
		if (!packed(file)) {
			problems.push(`${file} is not packed`);
		}
	}
	const { repository, publishConfig } = manifest.data;
	const resources = piResources(manifest);
	problems.push(...resources.problems);
	for (const [kind, entry] of resources.entries) {
		if (GLOB.test(entry)) {
			problems.push(`pi.${kind} entry ${entry} is a pattern that cannot be verified; list plain paths`);
			continue;
		}
		const path = normalizeProjectDir(entry);
		const declared = sourceFiles.filter((file) => file === path || file.startsWith(`${path}/`));
		if (declared.length === 0) {
			problems.push(`declared ${kind} resource ${entry} does not exist in the source`);
		}
		for (const file of declared.filter((file) => !entries.includes(`package/${file}`))) {
			problems.push(`${file} of declared ${kind} resource ${entry} is not packed`);
		}
	}
	for (const entry of entries.filter((entry) => DEVELOPMENT_FILE.test(entry))) {
		problems.push(`development file ${entry} is packed`);
	}
	if (manifest.name !== member.name || manifest.version !== member.version) {
		problems.push(`the packed manifest is ${manifest.name ?? "?"}@${manifest.version ?? "?"}, not ${member.key}`);
	}
	if (manifest.private) {
		problems.push("the packed manifest is private");
	}
	for (const key of ["description", "license"]) {
		const value = manifest.data[key];
		if (typeof value !== "string" || value.trim() === "") {
			problems.push(`the packed manifest has no ${key}`);
		}
	}
	if (typeof repository !== "string" && typeof field(repository, "url") !== "string") {
		problems.push("the packed manifest has no repository");
	}
	if (field(publishConfig, "access") !== "public") {
		problems.push('the packed manifest lacks publishConfig.access "public"');
	}
	for (const host of HOST_PACKAGES) {
		if (host in dependencies(manifest, "dependencies") || host in dependencies(manifest, "optionalDependencies")) {
			problems.push(`${host} is provided by Pi; declare it only in peerDependencies with "*"`);
		}
		const peer = dependencies(manifest, "peerDependencies")[host];
		if (peer !== undefined && peer !== "*") {
			problems.push(`peer dependency ${host} must use "*", not "${String(peer)}"`);
		}
	}
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [name, spec] of Object.entries(dependencies(manifest, field))) {
			if (typeof spec === "string" && spec.startsWith("workspace:")) {
				problems.push(`${field}.${name} still uses ${spec}`);
			}
		}
	}
	if (changelog !== undefined) {
		try {
			if (releaseNotes(changelog, member.version, "packed CHANGELOG.md") !== member.notes) {
				problems.push("the packed changelog section differs from the committed release notes");
			}
		} catch (error) {
			problems.push(errorMessage(error));
		}
	}
	return problems;
}

/** Extension command names from Pi's RPC answer to get_commands. */
export function extensionCommands(stdout: string): string[] {
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) {
			continue;
		}
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (field(message, "type") !== "response" || field(message, "command") !== "get_commands") {
			continue;
		}
		const commands = field(field(message, "data"), "commands");
		if (field(message, "success") !== true || !Array.isArray(commands)) {
			throw new ReleaseError(`Pi answered get_commands without commands: ${line}`);
		}
		return commands
			.filter((command) => field(command, "source") === "extension")
			.map((command) => String(field(command, "name")))
			.sort();
	}
	throw new ReleaseError("Pi did not answer get_commands");
}

/** The tarball path from `pnpm pack --json` output. */
export function packedTarball(stdout: string, outDir: string): string {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		throw new ReleaseError(`pnpm pack printed no JSON result: ${stdout.slice(0, 500)}`);
	}
	const filename = field(data, "filename");
	if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
		throw new ReleaseError("pnpm pack reported no tarball filename");
	}
	return resolve(outDir, filename);
}

export function assertOutside(workspace: string, dir: string): void {
	const path = relative(workspace, dir);
	if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) {
		throw new ReleaseError(`${dir} is inside the workspace ${workspace}; isolated checks need a directory outside it`);
	}
}

/** Loads one extension in the targeted Pi host with an empty agent directory and returns its commands. */
async function loadCommands(ctx: VerifyContext, extension: string, cwd: string): Promise<string[]> {
	const agentDir = await mkdtemp(join(ctx.workDir, "agent-"));
	const result = await ctx.run(ctx.hostBin, ["-ne", "-e", extension, "--mode", "rpc"], {
		cwd,
		input: `${JSON.stringify({ id: "1", type: "get_commands" })}\n`,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	});
	const output = `${result.stdout}\n${result.stderr}`;
	if (result.code !== 0 || output.includes("Failed to load extension")) {
		throw new ReleaseError(`Pi could not load ${extension} (exit ${result.code}): ${output.trim().slice(-2000)}`);
	}
	return extensionCommands(result.stdout);
}

export interface PackedArtifact {
	readonly member: PreparedMember;
	readonly tarball: string;
	/** The manifest inside the tarball, as consumers install it. */
	readonly manifest: PluginManifest;
}

/** Packs one member and inspects the actual tarball: file list, manifest, and changelog section. */
export async function packArtifact(ctx: VerifyContext, member: PreparedMember): Promise<PackedArtifact> {
	const packageDir = join(ctx.sourceDir, pluginDir(member.dirName));
	const tarball = packedTarball(
		await runChecked(ctx.run, "pnpm", ["pack", "--pack-destination", ctx.outDir, "--json"], { cwd: packageDir }),
		ctx.outDir,
	);
	const entries = (await runChecked(ctx.run, "tar", ["-tzf", tarball])).split("\n").filter((entry) => entry !== "");
	const manifest = parseManifest(
		await runChecked(ctx.run, "tar", ["-xzOf", tarball, "package/package.json"]),
		`${basename(tarball)}:package/package.json`,
	);
	const changelog = entries.includes("package/CHANGELOG.md")
		? await runChecked(ctx.run, "tar", ["-xzOf", tarball, "package/CHANGELOG.md"])
		: undefined;
	const sourceFiles = (await runChecked(ctx.run, "git", ["ls-files", "-z"], { cwd: packageDir }))
		.split("\0")
		.filter((file) => file !== "");
	const problems = tarballProblems(member, entries, manifest, changelog, sourceFiles);
	if (problems.length > 0) {
		throw new ReleaseError(problems.join("\n"));
	}
	return { member, tarball, manifest };
}

/**
 * pnpm overrides that resolve every dependency between batch members to the batch tarball, scoped to
 * the exact edge (`<dependent>@<version>><dependency>`) and only where the dependent's range accepts
 * the batch version. Batch versions are not on the registry yet; scoping keeps every other range,
 * including another member's dependency on an older version, resolving from the registry as it will
 * for consumers, and covers transitive dependencies between batch members.
 */
export function batchOverrides(batch: readonly PackedArtifact[]): Record<string, string> {
	const overrides: Record<string, string> = {};
	for (const dependent of batch) {
		for (const dependency of batch) {
			const { name, version } = dependency.member;
			if (dependency !== dependent && dependsOnVersion(dependent.manifest, name, version)) {
				overrides[`${dependent.member.name}@${dependent.member.version}>${name}`] = `file:${dependency.tarball}`;
			}
		}
	}
	return overrides;
}

/**
 * Installs one packed member outside the workspace as Pi installs packages (runtime dependencies,
 * no peers), with `batchOverrides` for dependencies on other batch members. The installed copy is
 * loaded in the targeted host and must expose the same extension commands as the workspace source.
 */
export async function installAndLoad(
	ctx: VerifyContext,
	artifact: PackedArtifact,
	batch: readonly PackedArtifact[],
): Promise<VerifiedArtifact> {
	const { member, tarball } = artifact;
	const root = await mkdtemp(join(ctx.workDir, `${member.dirName}-`));
	const manifest = { private: true, dependencies: { [member.name]: `file:${tarball}` } };
	await writeFile(join(root, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	const overrides = batchOverrides(batch);
	if (Object.keys(overrides).length > 0) {
		await writeFile(join(root, "pnpm-workspace.yaml"), stringify({ overrides }));
	}
	await runChecked(
		ctx.run,
		"pnpm",
		[
			"install",
			"--config.auto-install-peers=false",
			"--config.strict-peer-dependencies=false",
			"--config.strict-dep-builds=false",
		],
		{ cwd: root },
	);
	const installed = join(root, "node_modules", ...member.name.split("/"));
	const isolated = await loadCommands(ctx, installed, root);
	const workspace = await loadCommands(ctx, join(ctx.sourceDir, pluginDir(member.dirName)), root);
	if (isolated.join("\n") !== workspace.join("\n")) {
		throw new ReleaseError(
			`the installed artifact exposes [${isolated.join(", ")}] but the workspace source exposes [${workspace.join(", ")}]`,
		);
	}
	return { key: member.key, file: basename(tarball), sha256: sha256(await readFile(tarball)), commands: isolated };
}
