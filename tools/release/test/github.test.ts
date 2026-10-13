import { describe, expect, it } from "vitest";
import type { Runner } from "../src/exec.ts";
import { ghGitHub, parseIncluded } from "../src/github.ts";

const SHA = "c".repeat(40);

function response(status: number, body: unknown): string {
	return `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
}

/** Answers `gh api` calls by path; records every call. */
function gh(answers: Record<string, string>): { run: Runner; calls: string[] } {
	const calls: string[] = [];
	const run: Runner = async (_command, args) => {
		calls.push(args.join(" "));
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const stdout = answers[path];
		return stdout === undefined
			? { code: 1, stdout: "", stderr: "gh: could not connect" }
			: { code: 0, stdout, stderr: "" };
	};
	return { run, calls };
}

describe("parseIncluded", () => {
	it("reads the status line and body", () => {
		expect(parseIncluded(response(404, { message: "Not Found" }))).toEqual({
			status: 404,
			body: '{"message":"Not Found"}',
		});
		expect(parseIncluded("gh: not logged in")).toBeUndefined();
	});
});

describe("ghGitHub", () => {
	const tag = "@zeroclover/pi-tps@0.1.0";
	const tagPath = "repos/o/r/git/ref/tags/%40zeroclover%2Fpi-tps%400.1.0";

	it("resolves missing, lightweight, and annotated tags", async () => {
		expect(await ghGitHub(gh({ [tagPath]: response(404, {}) }).run, "o/r").tagTarget(tag)).toBeUndefined();
		const lightweight = response(200, { object: { type: "commit", sha: SHA } });
		expect(await ghGitHub(gh({ [tagPath]: lightweight }).run, "o/r").tagTarget(tag)).toBe(SHA);
		const annotated = {
			[tagPath]: response(200, { object: { type: "tag", sha: "t".repeat(40) } }),
			[`repos/o/r/git/tags/${"t".repeat(40)}`]: response(200, { object: { type: "commit", sha: SHA } }),
		};
		expect(await ghGitHub(gh(annotated).run, "o/r").tagTarget(tag)).toBe(SHA);
	});

	it("never reads a failed lookup as a missing tag or release", async () => {
		const github = ghGitHub(gh({ [tagPath]: response(500, {}) }).run, "o/r");
		await expect(github.tagTarget(tag)).rejects.toThrow(/HTTP 500/);
		await expect(github.releaseExists(tag)).rejects.toThrow(/could not connect/);
	});

	it("distinguishes existing and missing releases", async () => {
		const path = "repos/o/r/releases/tags/%40zeroclover%2Fpi-tps%400.1.0";
		expect(await ghGitHub(gh({ [path]: response(200, { tag_name: tag }) }).run, "o/r").releaseExists(tag)).toBe(true);
		expect(await ghGitHub(gh({ [path]: response(404, {}) }).run, "o/r").releaseExists(tag)).toBe(false);
	});

	it("creates lightweight tags at the given commit", async () => {
		const { run, calls } = gh({ "repos/o/r/git/refs": response(201, {}) });
		await ghGitHub(run, "o/r").createTag(tag, SHA);
		expect(calls).toEqual([`api --include --method POST repos/o/r/git/refs -f ref=refs/tags/${tag} -f sha=${SHA}`]);
	});

	it("maps pull requests associated with a commit", async () => {
		const pulls = [{ number: 7, merged_at: "2026-10-01T00:00:00Z", merge_commit_sha: SHA, base: { ref: "master" } }];
		const github = ghGitHub(gh({ [`repos/o/r/commits/${SHA}/pulls`]: response(200, pulls) }).run, "o/r");
		expect(await github.pullsForCommit(SHA)).toEqual([
			{ number: 7, merged: true, mergeCommitSha: SHA, baseRef: "master" },
		]);
	});
});
