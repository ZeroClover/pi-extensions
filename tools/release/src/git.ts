import { ReleaseError } from "./errors.ts";
import type { CommandResult, Runner } from "./exec.ts";

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Read-only Git queries (plus fetch). Unavailable history is an error, never an empty state. */
export class Git {
	readonly #run: Runner;
	readonly #cwd: string;

	constructor(run: Runner, cwd: string) {
		this.#run = run;
		this.#cwd = cwd;
	}

	#exec(args: readonly string[], input?: string): Promise<CommandResult> {
		return this.#run("git", args, { cwd: this.#cwd, input });
	}

	async #out(args: readonly string[], input?: string): Promise<string> {
		const result = await this.#exec(args, input);
		if (result.code !== 0) {
			throw new ReleaseError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
		}
		return result.stdout;
	}

	/** The full SHA of a locally available commit. */
	async commit(rev: string): Promise<string> {
		const result = await this.#exec(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
		const sha = result.stdout.trim();
		if (result.code !== 0 || !SHA.test(sha)) {
			throw new ReleaseError(`commit ${rev} is not available`);
		}
		return sha;
	}

	async parents(sha: string): Promise<string[]> {
		const [, ...parents] = (await this.#out(["rev-list", "--parents", "-n", "1", sha])).trim().split(" ");
		return parents;
	}

	/** The blob id of a path at a commit; undefined when the readable tree has no such path. */
	async blobId(commit: string, path: string): Promise<string | undefined> {
		const output = await this.#out(["ls-tree", "-z", commit, "--", path]);
		if (output === "") {
			return undefined;
		}
		const match = /^\d+ (\w+) ([0-9a-f]+)\t/.exec(output);
		if (match?.[1] !== "blob" || match[2] === undefined) {
			throw new ReleaseError(`${path} at ${commit} is not a file`);
		}
		return match[2];
	}

	readBlob(id: string): Promise<string> {
		return this.#out(["cat-file", "blob", id]);
	}

	async readFile(commit: string, path: string): Promise<string | undefined> {
		const id = await this.blobId(commit, path);
		return id === undefined ? undefined : this.readBlob(id);
	}

	/** Names of the entries of one type directly inside a directory at a commit. */
	async entries(commit: string, dir: string, type: "blob" | "tree"): Promise<string[]> {
		const output = await this.#out(["ls-tree", "-z", commit, "--", `${dir}/`]);
		return output
			.split("\0")
			.filter((entry) => entry !== "")
			.flatMap((entry) => {
				const match = /^\d+ (\w+) [0-9a-f]+\t(.+)$/.exec(entry);
				return match?.[1] === type && match[2] !== undefined ? [match[2].slice(dir.length + 1)] : [];
			});
	}

	async changedPaths(from: string, to: string): Promise<string[]> {
		const output = await this.#out(["diff", "--name-only", "-z", "--no-renames", from, to]);
		return output.split("\0").filter((path) => path !== "");
	}

	async mergeBase(a: string, b: string): Promise<string> {
		return this.commit((await this.#out(["merge-base", a, b])).trim());
	}

	/** First-parent commits after `from` up to `to`, oldest first; `from` must lie on that history. */
	async firstParentAfter(from: string, to: string): Promise<string[]> {
		const output = await this.#out(["rev-list", "--first-parent", "--reverse", `${from}..${to}`]);
		const commits = output.split("\n").filter((line) => line !== "");
		const [oldest] = commits;
		const onHistory = oldest === undefined ? from === to : (await this.parents(oldest))[0] === from;
		if (!onHistory) {
			throw new ReleaseError(`${from} is not on the first-parent history of ${to}`);
		}
		return commits;
	}

	/** Blob ids of one path at many commits from a single process; undefined where the path is absent. */
	async blobIds(commits: readonly string[], path: string): Promise<Map<string, string | undefined>> {
		const ids = new Map<string, string | undefined>();
		if (commits.length === 0) {
			return ids;
		}
		const input = `${commits.map((commit) => `${commit}:${path}`).join("\n")}\n`;
		const lines = (await this.#out(["cat-file", "--batch-check=%(objectname) %(objecttype)"], input))
			.split("\n")
			.filter((line) => line !== "");
		if (lines.length !== commits.length) {
			throw new ReleaseError(`git cat-file answered ${lines.length} of ${commits.length} lookups`);
		}
		commits.forEach((commit, i) => {
			const line = lines[i] ?? "";
			if (line === `${commit}:${path} missing`) {
				ids.set(commit, undefined);
				return;
			}
			const [id, type] = line.split(" ");
			if (type !== "blob" || id === undefined || !/^[0-9a-f]+$/.test(id)) {
				throw new ReleaseError(`unexpected git cat-file answer for ${commit}:${path}: ${line}`);
			}
			ids.set(commit, id);
		});
		return ids;
	}

	/** Fetches the current tip of a remote branch and returns it. */
	async fetchBranch(remote: string, branch: string): Promise<string> {
		await this.#out([
			"fetch",
			"--no-tags",
			"--quiet",
			remote,
			`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
		]);
		return this.commit(`refs/remotes/${remote}/${branch}`);
	}
}
