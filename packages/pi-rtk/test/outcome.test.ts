import { describe, expect, it } from "vitest";
import { interpretRewrite, type RtkRun, runFailure } from "../src/outcome.ts";

function exited(code: number, stdout = "", stderr = ""): RtkRun {
	return { code, signal: null, stdout, stderr, timedOut: false };
}

describe("interpretRewrite", () => {
	it("rewrites on exit 0 and 3, trimming the trailing newline", () => {
		expect(interpretRewrite("git status", exited(0, "rtk git status\n"))).toEqual({
			kind: "rewrite",
			command: "rtk git status",
		});
		expect(interpretRewrite("git status", exited(3, "rtk git status\n"))).toEqual({
			kind: "rewrite",
			command: "rtk git status",
		});
	});

	it("keeps inner newlines of a multi-line rewrite", () => {
		expect(interpretRewrite("git status\ngit diff", exited(3, "rtk git status\nrtk git diff\n"))).toEqual({
			kind: "rewrite",
			command: "rtk git status\nrtk git diff",
		});
	});

	it("treats an identical or empty rewrite as unchanged", () => {
		expect(interpretRewrite("rtk git status", exited(3, "rtk git status\n"))).toEqual({ kind: "unchanged" });
		expect(interpretRewrite("  git status  ", exited(0, "git status\n"))).toEqual({ kind: "unchanged" });
		expect(interpretRewrite("git status", exited(0, ""))).toEqual({ kind: "unchanged" });
	});

	it("leaves the command unchanged on exit 1", () => {
		expect(interpretRewrite("vim x", exited(1))).toEqual({ kind: "unchanged" });
	});

	it("blocks on exit 2 only when rtk printed a message", () => {
		expect(interpretRewrite("rm -rf /", exited(2, "denied by pipeline rule\n"))).toEqual({
			kind: "block",
			reason: "denied by pipeline rule",
		});
		expect(interpretRewrite("rm -rf /", exited(2, ""))).toEqual({ kind: "unchanged" });
	});

	it("never runs a deny message as a command", () => {
		const outcome = interpretRewrite("git push", exited(2, "rtk git push\n"));
		expect(outcome.kind).toBe("block");
	});

	it("reports other exit codes as failures with the first stderr line", () => {
		expect(interpretRewrite("git status", exited(101, "", "panicked at main.rs\nbacktrace"))).toEqual({
			kind: "failure",
			reason: "rtk rewrite exited with code 101: panicked at main.rs",
		});
	});

	it("reports timeouts, kills, and spawn errors as failures, ignoring partial output", () => {
		const base = { stdout: "rtk git", stderr: "" };
		expect(interpretRewrite("git status", { ...base, code: null, signal: "SIGKILL", timedOut: true }).kind).toBe(
			"failure",
		);
		expect(interpretRewrite("git status", { ...base, code: null, signal: "SIGSEGV", timedOut: false })).toEqual({
			kind: "failure",
			reason: "rtk rewrite was killed by SIGSEGV",
		});
		expect(
			interpretRewrite("git status", {
				...base,
				code: null,
				signal: null,
				timedOut: false,
				error: "ENOENT: spawn rtk ENOENT",
			}),
		).toEqual({ kind: "failure", reason: "rtk rewrite could not run: ENOENT: spawn rtk ENOENT" });
	});
});

describe("runFailure", () => {
	it("is undefined for a normal exit", () => {
		expect(runFailure("rtk", exited(1))).toBeUndefined();
	});
});
