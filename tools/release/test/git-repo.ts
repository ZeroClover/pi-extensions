import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runChecked, runCommand } from "../src/exec.ts";

/** Git isolated from the user's configuration, with a fixed identity. */
const ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Release Test",
	GIT_AUTHOR_EMAIL: "release-test@example.com",
	GIT_COMMITTER_NAME: "Release Test",
	GIT_COMMITTER_EMAIL: "release-test@example.com",
};

/** A throwaway working repository on `master` with a bare `origin`. */
export class TestRepo {
	readonly root: string;
	readonly dir: string;

	private constructor(root: string) {
		this.root = root;
		this.dir = join(root, "work");
	}

	static async create(): Promise<TestRepo> {
		const repo = new TestRepo(await mkdtemp(join(tmpdir(), "release-flow-")));
		await runChecked(runCommand, "git", ["init", "-q", "--bare", "-b", "master", join(repo.root, "origin.git")], {
			env: ENV,
		});
		await runChecked(runCommand, "git", ["init", "-q", "-b", "master", repo.dir], { env: ENV });
		await repo.git("remote", "add", "origin", join(repo.root, "origin.git"));
		return repo;
	}

	async git(...args: string[]): Promise<string> {
		return (await runChecked(runCommand, "git", args, { cwd: this.dir, env: ENV })).trim();
	}

	/** Writes (or, for null, deletes) files, then commits everything. */
	async commit(message: string, files: Record<string, string | null> = {}): Promise<string> {
		for (const [path, content] of Object.entries(files)) {
			const file = join(this.dir, path);
			if (content === null) {
				await rm(file, { force: true });
			} else {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, content);
			}
		}
		await this.git("add", "-A");
		await this.git("commit", "-q", "--allow-empty", "-m", message);
		return this.git("rev-parse", "HEAD");
	}

	/** A two-parent merge of `branch` into the current branch. */
	async merge(branch: string, message: string): Promise<string> {
		await this.git("merge", "-q", "--no-ff", "-m", message, branch);
		return this.git("rev-parse", "HEAD");
	}

	async push(): Promise<void> {
		await this.git("push", "-q", "origin", "HEAD:refs/heads/master");
	}

	async cleanup(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}
