import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runFile } from "../src/run.ts";

const node = process.execPath;

describe("runFile", () => {
	it("reports exit codes with output", async () => {
		const run = await runFile(node, ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"], {
			timeoutMs: 5000,
		});
		expect(run).toEqual({ code: 3, signal: null, stdout: "out", stderr: "err", timedOut: false });
		expect((await runFile(node, ["-e", ""], { timeoutMs: 5000 })).code).toBe(0);
	});

	it("passes the command as one argument, without a shell", async () => {
		const run = await runFile(node, ["-e", "process.stdout.write(process.argv[1])", "a && b; $(x) 'q'"], {
			timeoutMs: 5000,
		});
		expect(run.stdout).toBe("a && b; $(x) 'q'");
	});

	it("runs in the given directory", async () => {
		const run = await runFile(node, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmpdir(), timeoutMs: 5000 });
		expect(run.code).toBe(0);
		expect(run.stdout).not.toBe(process.cwd());
	});

	it("reports a missing binary as an error, not as exit code 1", async () => {
		const run = await runFile("/nonexistent/rtk", ["rewrite", "git status"], { timeoutMs: 5000 });
		expect(run.code).toBeNull();
		expect(run.error).toMatch(/ENOENT/);
	});

	it("kills and reports a process that exceeds the timeout", async () => {
		const run = await runFile(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200 });
		expect(run.timedOut).toBe(true);
		expect(run.code).toBeNull();
	});

	it("reports a signal exit instead of a success", async () => {
		const run = await runFile(node, ["-e", "process.kill(process.pid, 'SIGKILL')"], { timeoutMs: 5000 });
		expect(run).toMatchObject({ code: null, signal: "SIGKILL", timedOut: false });
	});

	it("stops on cancellation without reporting a timeout", async () => {
		const controller = new AbortController();
		const pending = runFile(node, ["-e", "setTimeout(() => {}, 60000)"], {
			timeoutMs: 5000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);
		const run = await pending;
		expect(run.timedOut).toBe(false);
		expect(run.code).toBeNull();
	});
});
