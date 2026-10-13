import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequest } from "./batch.ts";
import { field, ReleaseError } from "./errors.ts";
import { type Runner, runChecked } from "./exec.ts";

/** The GitHub operations the release workflow needs; tests substitute doubles. */
export interface GitHub {
	pullsForCommit(sha: string): Promise<PullRequest[]>;
	/** The commit a tag points to, or undefined when the tag does not exist. */
	tagTarget(tag: string): Promise<string | undefined>;
	createTag(tag: string, sha: string): Promise<void>;
	releaseExists(tag: string): Promise<boolean>;
	createRelease(tag: string, notes: string): Promise<void>;
}

interface ApiResponse {
	readonly status: number;
	readonly data: unknown;
}

/** Splits `gh api --include` output into its HTTP status and JSON body; the status line decides, not the exit code. */
export function parseIncluded(stdout: string): { readonly status: number; readonly body: string } | undefined {
	const status = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout)?.[1];
	if (status === undefined) {
		return undefined;
	}
	const separator = /\r?\n\r?\n/.exec(stdout);
	return {
		status: Number(status),
		body: separator === null ? "" : stdout.slice(separator.index + separator[0].length),
	};
}

/** GitHub through the authenticated `gh` CLI (GH_TOKEN in CI). */
export function ghGitHub(run: Runner, repo: string): GitHub {
	async function api(args: readonly string[]): Promise<ApiResponse> {
		const result = await run("gh", ["api", "--include", ...args]);
		const included = parseIncluded(result.stdout);
		if (included === undefined) {
			throw new ReleaseError(`gh api ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
		}
		let data: unknown;
		try {
			data = included.body.trim() === "" ? undefined : JSON.parse(included.body);
		} catch {
			throw new ReleaseError(`gh api ${args.join(" ")}: HTTP ${included.status} with an invalid JSON body`);
		}
		return { status: included.status, data };
	}

	function unexpected(what: string, response: ApiResponse): ReleaseError {
		return new ReleaseError(`${what}: unexpected HTTP ${response.status}`);
	}

	return {
		async pullsForCommit(sha) {
			const response = await api([`repos/${repo}/commits/${sha}/pulls`]);
			if (response.status !== 200 || !Array.isArray(response.data)) {
				throw unexpected(`pull requests of ${sha}`, response);
			}
			return response.data.map((pr: unknown) => {
				const number = field(pr, "number");
				const mergeCommit = field(pr, "merge_commit_sha");
				const baseRef = field(field(pr, "base"), "ref");
				return {
					number: typeof number === "number" ? number : 0,
					merged: typeof field(pr, "merged_at") === "string",
					mergeCommitSha: typeof mergeCommit === "string" ? mergeCommit : null,
					baseRef: typeof baseRef === "string" ? baseRef : "",
				};
			});
		},

		async tagTarget(tag) {
			const what = `tag ${tag}`;
			const response = await api([`repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`]);
			if (response.status === 404) {
				return undefined;
			}
			const object = field(response.data, "object");
			const type = field(object, "type");
			const sha = field(object, "sha");
			if (response.status !== 200 || typeof sha !== "string") {
				throw unexpected(what, response);
			}
			if (type === "commit") {
				return sha;
			}
			if (type !== "tag") {
				throw new ReleaseError(`${what} points to a ${String(type)}`);
			}
			const annotated = await api([`repos/${repo}/git/tags/${sha}`]);
			const target = field(annotated.data, "object");
			const commit = field(target, "sha");
			if (annotated.status !== 200 || field(target, "type") !== "commit" || typeof commit !== "string") {
				throw unexpected(what, annotated);
			}
			return commit;
		},

		async createTag(tag, sha) {
			const response = await api([
				"--method",
				"POST",
				`repos/${repo}/git/refs`,
				"-f",
				`ref=refs/tags/${tag}`,
				"-f",
				`sha=${sha}`,
			]);
			if (response.status !== 201) {
				throw unexpected(`creating tag ${tag}`, response);
			}
		},

		async releaseExists(tag) {
			const response = await api([`repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
			if (response.status === 404) {
				return false;
			}
			if (response.status !== 200) {
				throw unexpected(`release ${tag}`, response);
			}
			return true;
		},

		async createRelease(tag, notes) {
			const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
			try {
				const file = join(dir, "notes.md");
				await writeFile(file, `${notes}\n`);
				// --verify-tag: never let gh create a missing tag at the current default-branch head.
				await runChecked(run, "gh", [
					"release",
					"create",
					tag,
					"--repo",
					repo,
					"--verify-tag",
					"--title",
					tag,
					"--notes-file",
					file,
				]);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}
