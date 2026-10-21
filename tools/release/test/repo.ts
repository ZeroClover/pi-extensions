import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GhStub } from "./gh.ts";
import type { RegistryDouble } from "./registry.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = join(ROOT, "tools/release/src/cli.ts");
export const GITHUB_REPO = "ZeroClover/pi-fixture";

export interface Result {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** stdout and stderr together, for matching messages wherever the CLI printed them. */
	readonly output: string;
}

/** A plugin of the fixture workspace. */
export interface PluginOptions {
	readonly version: string;
	/** Extra or replaced manifest fields. */
	readonly manifest?: Record<string, unknown>;
	/** The extension entry; by default it registers a command named after the directory. */
	readonly index?: string;
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Result> {
	return new Promise((done, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			const out = Buffer.concat(stdout).toString("utf8");
			const err = Buffer.concat(stderr).toString("utf8");
			done({ code: code ?? 1, stdout: out, stderr: err, output: `${out}\n${err}` });
		});
	});
}

function manifest(dirName: string, options: PluginOptions): string {
	const data = {
		name: `@zeroclover/${dirName}`,
		version: options.version,
		description: `${dirName} for tests`,
		license: "AGPL-3.0-only",
		repository: { type: "git", url: "git+https://github.com/ZeroClover/pi-fixture.git" },
		type: "module",
		files: ["src", "README.md", "CHANGELOG.md"],
		publishConfig: { access: "public" },
		pi: { extensions: ["./src/index.ts"] },
		peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
		...options.manifest,
	};
	return `${JSON.stringify(data, null, "\t")}\n`;
}

/**
 * A temporary pnpm workspace in git on `master`, with a bare `origin`, a `gh` stub first on `PATH`, and pnpm
 * pointed at the registry double. Release files are written only by real `pnpm change` and `pnpm version -r`.
 */
export class TestRepo {
	readonly root: string;
	readonly dir: string;
	readonly gh: GhStub;
	readonly registry: RegistryDouble;
	readonly #env: NodeJS.ProcessEnv;
	#nextPull = 1;

	private constructor(root: string, gh: GhStub, registry: RegistryDouble, env: NodeJS.ProcessEnv) {
		this.root = root;
		this.dir = join(root, "work");
		this.gh = gh;
		this.registry = registry;
		this.#env = env;
	}

	static async create(registry: RegistryDouble): Promise<TestRepo> {
		const root = await mkdtemp(join(tmpdir(), "release-cli-"));
		const bin = join(root, "bin");
		await mkdir(bin);
		const gh = await GhStub.create(bin, GITHUB_REPO);
		const { PATH = "" } = process.env;
		const env: NodeJS.ProcessEnv = {};
		for (const [name, value] of Object.entries(process.env)) {
			// pnpm passes its own configuration to scripts; the fixture's .npmrc and the values below decide instead.
			if (/^(npm|pnpm)_config_/i.test(name) || name.startsWith("GITHUB_")) continue;
			env[name] = value;
		}
		Object.assign(env, {
			...gh.env,
			PATH: `${bin}:${PATH}`,
			npm_config_registry: registry.url,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Release Test",
			GIT_AUTHOR_EMAIL: "release-test@example.com",
			GIT_COMMITTER_NAME: "Release Test",
			GIT_COMMITTER_EMAIL: "release-test@example.com",
		});
		const repo = new TestRepo(root, gh, registry, env);
		await repo.#checked("git", ["init", "-q", "--bare", "-b", "master", join(root, "origin.git")], root);
		await repo.#checked("git", ["init", "-q", "-b", "master", repo.dir], root);
		await repo.git("remote", "add", "origin", join(root, "origin.git"));
		const host = new URL(registry.url).host;
		await repo.write({
			"package.json": `${JSON.stringify({ name: "fixture-root", version: "0.0.0", private: true }, null, "\t")}\n`,
			"pnpm-workspace.yaml": [
				"packages:",
				"  - packages/*",
				"versioning:",
				"  ignore:",
				"    - fixture-root",
				"  changelog:",
				"    storage: repository",
				"",
			].join("\n"),
			".gitignore": "node_modules\n.npmrc\n",
			".npmrc": `registry=${registry.url}\n//${host}/:_authToken=fixture-token\n`,
			"README.md": "# fixture\n",
		});
		await copyFile(join(ROOT, "LICENSE"), join(repo.dir, "LICENSE"));
		// The release commit's own Pi host, which verify and preflight run; never the `pi` on PATH.
		await mkdir(join(repo.dir, "node_modules/.bin"), { recursive: true });
		await symlink(join(ROOT, "node_modules/.bin/pi"), join(repo.dir, "node_modules/.bin/pi"));
		return repo;
	}

	async #checked(command: string, args: readonly string[], cwd = this.dir): Promise<string> {
		const result = await run(command, args, cwd, this.#env);
		if (result.code !== 0) {
			throw new Error(`${command} ${args.join(" ")} exited with ${result.code}: ${result.output.trim()}`);
		}
		return result.stdout;
	}

	async git(...args: string[]): Promise<string> {
		return (await this.#checked("git", args)).trim();
	}

	/** Runs `node tools/release/src/cli.ts <args>` in the fixture, as CI does. */
	cli(...args: string[]): Promise<Result> {
		return this.cliWith({}, ...args);
	}

	/** `cli` with extra environment, such as `GITHUB_OUTPUT`. */
	cliWith(env: Record<string, string>, ...args: string[]): Promise<Result> {
		return run(process.execPath, [CLI, ...args], this.dir, { ...this.#env, ...env });
	}

	/** Writes files, or deletes them for null. */
	async write(files: Record<string, string | null>): Promise<void> {
		for (const [path, content] of Object.entries(files)) {
			const file = join(this.dir, path);
			if (content === null) {
				await rm(file, { force: true });
			} else {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, content);
			}
		}
	}

	/** The files of a plugin directory. */
	plugin(dirName: string, options: PluginOptions): Record<string, string> {
		const index =
			options.index ??
			`export default function (pi) {\n\tpi.registerCommand("${dirName}", { description: "${dirName}", handler: async () => {} });\n}\n`;
		return {
			[`packages/${dirName}/package.json`]: manifest(dirName, options),
			[`packages/${dirName}/README.md`]: `# ${dirName}\n`,
			[`packages/${dirName}/src/index.ts`]: index,
		};
	}

	/** Writes (or deletes) files, then commits everything. */
	async commit(message: string, files: Record<string, string | null> = {}): Promise<string> {
		await this.write(files);
		await this.git("add", "-A");
		await this.git("commit", "-q", "--allow-empty", "-m", message);
		return this.git("rev-parse", "HEAD");
	}

	/** `pnpm change --bump <bump> --summary <summary> <names>`, committed. */
	async change(bump: string, summary: string, ...names: string[]): Promise<string> {
		await this.#checked("pnpm", ["change", "--bump", bump, "--summary", summary, ...names]);
		return this.commit(`chore: ${bump} intent: ${summary}`);
	}

	/**
	 * `pnpm version -r`, limited to `filter` packages when given, committed. pnpm asks the registry double whether
	 * the current version is published, which decides between a first release and a bump.
	 */
	async version(message = "chore(release): pnpm version -r", ...filter: string[]): Promise<string> {
		await this.#checked("pnpm", [...filter.flatMap((name) => ["--filter", name]), "version", "-r"]);
		return this.commit(message);
	}

	/**
	 * A pull request: `work` commits on a branch from `master`, which then lands as one squash commit that the
	 * `gh` stub associates with a merged pull request. Returns the squash commit.
	 */
	async pullRequest(title: string, work: () => Promise<unknown>): Promise<string> {
		const number = this.#nextPull++;
		const branch = `pr-${number}`;
		await this.git("checkout", "-q", "-b", branch, "master");
		await work();
		await this.git("checkout", "-q", "master");
		await this.git("merge", "-q", "--squash", branch);
		await this.git("commit", "-q", "--allow-empty", "-m", `${title} (#${number})`);
		await this.git("branch", "-q", "-D", branch);
		const sha = await this.git("rev-parse", "HEAD");
		await this.gh.merged(sha, number);
		return sha;
	}

	async push(): Promise<void> {
		await this.git("push", "-q", "origin", "HEAD:refs/heads/master");
	}

	async show(rev: string, path: string): Promise<string> {
		return this.#checked("git", ["show", `${rev}:${path}`]);
	}

	async cleanup(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

export const A = "@zeroclover/pi-a";
export const B = "@zeroclover/pi-b";

/**
 * The common history: pi-a never released at 0.1.0, pi-b released at 2.1.2 (prepared by pnpm from 2.1.1 and on
 * the registry), pushed to `origin`. Returns the `master` head.
 */
export async function seed(repo: TestRepo): Promise<string> {
	repo.registry.publish(B, "2.1.1");
	await repo.commit("chore: init", {
		...repo.plugin("pi-a", { version: "0.1.0" }),
		...repo.plugin("pi-b", { version: "2.1.1" }),
	});
	await repo.change("patch", "Earlier fix", B);
	await repo.version("chore(release): prepare pi-b 2.1.2");
	repo.registry.publish(B, "2.1.2");
	await repo.push();
	return repo.git("rev-parse", "HEAD");
}

/** A merged feature pull request that changes both plugins with their own intents. */
export async function features(repo: TestRepo): Promise<string> {
	return repo.pullRequest("feat: change both plugins", async () => {
		await repo.commit("feat(pi-a): feature", { "packages/pi-a/src/feature.ts": "export const feature = 1;\n" });
		await repo.change("minor", "A feature", A);
		await repo.commit("fix(pi-b): fix", { "packages/pi-b/src/fix.ts": "export const fix = 1;\n" });
		await repo.change("patch", "B urgent fix", B);
	});
}
