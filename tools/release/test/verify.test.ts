import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflightRelease, verifyRelease } from "../src/commands.ts";
import { type CommandResult, type Runner, runCommand } from "../src/exec.ts";
import { Git } from "../src/git.ts";
import { BATCH_FILE } from "../src/publish.ts";
import { ReleaseRepository } from "../src/repository.ts";
import { changelogText, intentText, ledgerText, manifestText } from "./fixtures.ts";
import { TestRepo } from "./git-repo.ts";

const A = "@zeroclover/pi-a";
const B = "@zeroclover/pi-b";
const HOST = "/fake/bin/pi";

let repo: TestRepo;
let scratch: string;
let source: string;

beforeEach(async () => {
	repo = await TestRepo.create();
	scratch = await mkdtemp(join(tmpdir(), "release-verify-"));
});

/** A batch of two first releases in which pi-a depends on pi-b with `range`, as pnpm prepares it. */
async function release(range = "^0.1.0"): Promise<void> {
	const plugin = (dirName: string) => ({
		[`packages/${dirName}/README.md`]: `# ${dirName}\n`,
		[`packages/${dirName}/src/index.ts`]: "export default function () {}\n",
	});
	await repo.commit("init", {
		...plugin("pi-a"),
		...plugin("pi-b"),
		"packages/pi-a/package.json": manifestText("pi-a", "0.1.0", { dependencies: { [B]: range } }),
		"packages/pi-b/package.json": manifestText("pi-b", "0.1.0"),
		".changeset/a.md": intentText({ [A]: "minor" }, "A"),
		".changeset/b.md": intentText({ [B]: "minor" }, "B"),
	});
	source = await repo.commit("chore(release): prepare", {
		"packages/pi-a/CHANGELOG.md": changelogText(A, [["0.1.0", "### Minor Changes\n\n- A"]]),
		"packages/pi-b/CHANGELOG.md": changelogText(B, [["0.1.0", "### Minor Changes\n\n- B"]]),
		".changeset/ledger.yaml": ledgerText({ [`${A}@0.1.0`]: ["a"], [`${B}@0.1.0`]: ["b"] }),
		".changeset/a.md": null,
		".changeset/b.md": null,
	});
}

afterEach(async () => {
	await repo.cleanup();
	await rm(scratch, { recursive: true, force: true });
});

interface Scenario {
	/** Extension commands the installed copy of each package exposes, or an Error to fail loading. */
	readonly installed?: Readonly<Record<string, readonly string[] | Error>>;
	/** Tarball entries to drop for a package. */
	readonly missing?: Readonly<Record<string, readonly string[]>>;
}

/** Real git; doubles for pnpm pack/install, tar, and the Pi host. Records every install root. */
function runner(scenario: Scenario): {
	run: Runner;
	installs: { root: string; manifest: string; workspace: string }[];
} {
	const installs: { root: string; manifest: string; workspace: string }[] = [];
	const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
	const dirOf = (tarball: string): string => /zeroclover-(pi-[a-z]+)-/.exec(basename(tarball))?.[1] ?? "";
	const run: Runner = async (command, args, options = {}) => {
		if (command === "git") {
			return runCommand(command, args, options);
		}
		if (command === "pnpm" && args[0] === "pack") {
			const dirName = basename(options.cwd ?? "");
			const tarball = join(args[2] ?? "", `zeroclover-${dirName}-0.1.0.tgz`);
			await writeFile(tarball, `tarball of ${dirName}`);
			return ok(JSON.stringify({ filename: tarball }));
		}
		if (command === "tar" && args[0] === "-tzf") {
			const dirName = dirOf(args[1] ?? "");
			const files = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "src/index.ts"];
			const missing = scenario.missing?.[dirName] ?? [];
			return ok(
				files
					.filter((file) => !missing.includes(file))
					.map((file) => `package/${file}\n`)
					.join(""),
			);
		}
		if (command === "tar" && args[0] === "-xzOf") {
			const file = (args[2] ?? "").slice("package/".length);
			return ok(await readFile(join(repo.dir, "packages", dirOf(args[1] ?? ""), file), "utf8"));
		}
		if (command === "pnpm" && args[0] === "install") {
			const root = options.cwd ?? "";
			const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8").catch(() => "");
			installs.push({ root, manifest: await readFile(join(root, "package.json"), "utf8"), workspace });
			return ok("");
		}
		if (command === HOST) {
			const extension = args[2] ?? "";
			const dirName = /(pi-[a-z]+)$/.exec(extension)?.[1] ?? "";
			const isolated = extension.includes("/node_modules/");
			const commands = isolated ? (scenario.installed?.[dirName] ?? [dirName]) : [dirName];
			if (commands instanceof Error) {
				return { code: 1, stdout: "", stderr: `Failed to load extension: ${commands.message}` };
			}
			const answer = {
				id: "1",
				type: "response",
				command: "get_commands",
				success: true,
				data: { commands: commands.map((name) => ({ name, source: "extension" })) },
			};
			return ok(`${JSON.stringify(answer)}\n`);
		}
		throw new Error(`unexpected command ${command} ${args.join(" ")}`);
	};
	return { run, installs };
}

async function verify(scenario: Scenario, range?: string) {
	await release(range);
	const { run, installs } = runner(scenario);
	const outDir = await mkdtemp(join(scratch, "out-"));
	const workDir = await mkdtemp(join(scratch, "work-"));
	const result = verifyRelease(
		new ReleaseRepository(new Git(runCommand, repo.dir)),
		{ run, sourceDir: repo.dir, outDir, workDir, hostBin: HOST },
		source,
	);
	return { result, installs, outDir };
}

describe("verifyRelease", () => {
	it("verifies the whole batch, resolving batch-internal dependencies to batch tarballs", async () => {
		const { result, installs, outDir } = await verify({});
		const verified = await result;
		expect(verified.artifacts.map((artifact) => [artifact.key, artifact.commands])).toEqual([
			[`${B}@0.1.0`, ["pi-b"]],
			[`${A}@0.1.0`, ["pi-a"]],
		]);
		const forA = installs.find((install) => install.manifest.includes(A));
		expect(forA?.manifest).toContain(`"${A}": "file:${join(outDir, "zeroclover-pi-a-0.1.0.tgz")}"`);
		expect(forA?.workspace).toContain(`"${A}@0.1.0>${B}": file:${join(outDir, "zeroclover-pi-b-0.1.0.tgz")}`);
		const batch = JSON.parse(await readFile(join(outDir, BATCH_FILE), "utf8"));
		expect(batch.source).toBe(source);
		expect(batch.members.map((member: { key: string }) => member.key)).toEqual([`${B}@0.1.0`, `${A}@0.1.0`]);
	});

	it("resolves a dependency whose range excludes the batch version from the registry, as consumers do", async () => {
		const { result, installs } = await verify({}, "^0.0.1");
		const verified = await result;
		expect(verified.artifacts.map((artifact) => artifact.key)).toEqual([`${A}@0.1.0`, `${B}@0.1.0`]);
		expect(installs.find((install) => install.manifest.includes(A))?.workspace).toBe("");
	});

	it("blocks every member when one installed copy fails to load", async () => {
		const { result, outDir } = await verify({
			installed: { "pi-a": new Error("Cannot find module '@zeroclover/pi-b'") },
		});
		await expect(result).rejects.toThrow(/no member of this batch may be uploaded[\s\S]*pi-a@0.1.0: Pi could not load/);
		await expect(readFile(join(outDir, BATCH_FILE), "utf8")).rejects.toThrow(/ENOENT/);
	});

	it("rejects an installed copy that exposes different commands than the source", async () => {
		const { result } = await verify({ installed: { "pi-b": [] } });
		await expect(result).rejects.toThrow(
			/pi-b@0.1.0: the installed artifact exposes \[\] but the workspace source exposes \[pi-b\]/,
		);
	});

	it("stops before any install when a tarball misses required files", async () => {
		const { result, installs } = await verify({ missing: { "pi-b": ["CHANGELOG.md"] } });
		await expect(result).rejects.toThrow(/pi-b@0.1.0: CHANGELOG.md is not packed/);
		expect(installs).toEqual([]);
	});
});

describe("preflightRelease", () => {
	async function preflight(scenario: Scenario, baseRev: string, headRev = "HEAD") {
		const { run, installs } = runner(scenario);
		const outDir = await mkdtemp(join(scratch, "out-"));
		const workDir = await mkdtemp(join(scratch, "work-"));
		const result = preflightRelease(
			new ReleaseRepository(new Git(runCommand, repo.dir)),
			{ run, sourceDir: repo.dir, outDir, workDir, hostBin: HOST },
			{ baseRev, headRev },
		);
		return { result, installs, outDir };
	}

	it("verifies the records a pull request adds relative to its merge base, across several commits", async () => {
		await release();
		const base = await repo.git("rev-parse", `${source}~1`);
		await repo.commit("docs: polish release notes");
		const { result, outDir } = await preflight({}, base);
		const verified = await result;
		expect(verified?.mergeBase).toBe(base);
		expect(verified?.artifacts.map((artifact) => artifact.key)).toEqual([`${B}@0.1.0`, `${A}@0.1.0`]);
		await expect(readFile(join(outDir, BATCH_FILE), "utf8")).rejects.toThrow(/ENOENT/);
	});

	it("is a no-op for a pull request without new release records", async () => {
		await release();
		await repo.commit("docs: unrelated", { "README.md": "# repo\n" });
		const { result, installs } = await preflight({}, source);
		expect(await result).toBeUndefined();
		expect(installs).toEqual([]);
	});

	it("fails the pull request when a member's installed copy does not load", async () => {
		await release();
		const { result } = await preflight(
			{ installed: { "pi-b": new Error("Cannot find module 'left-pad'") } },
			`${source}~1`,
		);
		await expect(result).rejects.toThrow(/pi-b@0.1.0: Pi could not load/);
	});

	it("refuses a checkout that is not the head under test", async () => {
		await release();
		const { result } = await preflight({}, `${source}~1`, `${source}~1`);
		await expect(result).rejects.toThrow(/the source checkout is at/);
	});
});
