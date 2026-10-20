import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTERS } from "../src/adapters.ts";
import { formatStatus, parseRtkArgs } from "../src/command.ts";
import { checkVersion, MAX_CONSECUTIVE_FAILURES, RECHECK_MS, type Reporter, RtkController } from "../src/controller.ts";
import type { RtkRun } from "../src/outcome.ts";
import type { Run, RunOptions } from "../src/run.ts";

const cwd = tmpdir();

function exited(code: number, stdout = ""): RtkRun {
	return { code, signal: null, stdout, stderr: "", timedOut: false };
}

const missing: RtkRun = { code: null, signal: null, stdout: "", stderr: "", timedOut: false, error: "ENOENT" };

interface Call {
	args: string[];
	options: RunOptions;
}

/** A fake rtk: `--version` answers `version`, `rewrite` answers `rewrite(command)`. */
function fakeRtk(rewrite: (command: string) => RtkRun, version: () => RtkRun = () => exited(0, "rtk 1.0.1\n")) {
	const calls: Call[] = [];
	const run: Run = async (_file, args, options) => {
		calls.push({ args, options });
		return args[0] === "--version" ? version() : rewrite(args[1] ?? "");
	};
	return { run, calls };
}

function recorder() {
	const notices: { message: string; level: string }[] = [];
	const statuses: (string | undefined)[] = [];
	const reporter: Reporter = {
		notify: (message, level) => notices.push({ message, level }),
		setStatus: (text) => statuses.push(text),
	};
	return { reporter, notices, statuses };
}

async function started(run: Run, options: { env?: Record<string, string>; now?: () => number } = {}) {
	const { reporter, notices, statuses } = recorder();
	const env = options.env ?? {};
	const controller = new RtkController({
		run,
		getEnv: (name) => env[name],
		...(options.now ? { now: options.now } : {}),
	});
	await controller.start(new Map(Object.entries(BUILTIN_ADAPTERS)), reporter);
	return { controller, reporter, notices, statuses };
}

describe("RtkController.handleToolCall", () => {
	it("rewrites bash and exec_command input in place", async () => {
		const { run, calls } = fakeRtk((command) => exited(3, `rtk ${command}\n`));
		const { controller, reporter } = await started(run);

		const bash = { command: "git status" };
		expect(await controller.handleToolCall("bash", bash, cwd, undefined, reporter)).toBeUndefined();
		expect(bash.command).toBe("rtk git status");

		const exec = { cmd: "git diff", workdir: "." };
		await controller.handleToolCall("exec_command", exec, cwd, undefined, reporter);
		expect(exec.cmd).toBe("rtk git diff");
		expect(calls.at(-1)?.options.cwd).toBe(cwd);
		expect(controller.counts.rewritten).toBe(2);
	});

	it("ignores tools without an adapter", async () => {
		const { run, calls } = fakeRtk((command) => exited(3, `rtk ${command}\n`));
		const { controller, reporter } = await started(run);
		const input = { command: "git status" };
		await controller.handleToolCall("bg_run", input, cwd, undefined, reporter);
		expect(input.command).toBe("git status");
		expect(calls).toHaveLength(1);
	});

	it("blocks a command rtk denies with a message", async () => {
		const { run } = fakeRtk(() => exited(2, "blocked by pipeline rule\n"));
		const { controller, reporter } = await started(run);
		const input = { command: "git push --force" };
		expect(await controller.handleToolCall("bash", input, cwd, undefined, reporter)).toEqual({
			block: true,
			reason: "rtk: blocked by pipeline rule",
		});
		expect(input.command).toBe("git push --force");
		expect(controller.counts.blocked).toBe(1);
	});

	it("does not call rtk for skipped commands or a missing working directory", async () => {
		const { run, calls } = fakeRtk((command) => exited(3, `rtk ${command}\n`));
		const { controller, reporter } = await started(run);
		await controller.handleToolCall("exec_command", { cmd: "python3", tty: true }, cwd, undefined, reporter);
		await controller.handleToolCall("exec_command", { cmd: "dir", shell: "cmd" }, cwd, undefined, reporter);
		const input = { cmd: "git status", workdir: join(cwd, "pi-rtk-does-not-exist") };
		await controller.handleToolCall("exec_command", input, cwd, undefined, reporter);
		expect(input.cmd).toBe("git status");
		expect(calls).toHaveLength(1);
		expect(controller.counts.skipped).toBe(3);
		expect(controller.counts.failed).toBe(0);
	});

	it("leaves commands alone when off, or when RTK_DISABLED=1", async () => {
		const { run } = fakeRtk((command) => exited(3, `rtk ${command}\n`));
		const off = await started(run);
		off.controller.setEnabled(false, off.reporter);
		const input = { command: "git status" };
		await off.controller.handleToolCall("bash", input, cwd, undefined, off.reporter);
		expect(input.command).toBe("git status");
		expect(off.statuses.at(-1)).toBe("RTK off");

		const env = await started(run, { env: { RTK_DISABLED: "1" } });
		await env.controller.handleToolCall("bash", input, cwd, undefined, env.reporter);
		expect(input.command).toBe("git status");
		expect(env.statuses.at(-1)).toBe("RTK off");
		expect(formatStatus(env.controller, new Set())).toContain("state: off (RTK_DISABLED=1)");
	});

	it("does not count a cancelled call as an rtk failure", async () => {
		const abort = new AbortController();
		const { run } = fakeRtk(() => {
			abort.abort();
			return { ...missing, error: "AbortError" };
		});
		const { controller, reporter } = await started(run);
		const input = { command: "git status" };
		await controller.handleToolCall("bash", input, cwd, abort.signal, reporter);
		expect(input.command).toBe("git status");
		expect(controller.counts.failed).toBe(0);
	});

	it("suspends after consecutive failures until restarted", async () => {
		let healthy = false;
		const { run, calls } = fakeRtk((command) =>
			healthy ? exited(3, `rtk ${command}\n`) : { ...exited(0), code: null, timedOut: true },
		);
		const { controller, reporter, notices, statuses } = await started(run);
		for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
			await controller.handleToolCall("bash", { command: "git status" }, cwd, undefined, reporter);
		}
		expect(controller.suspended).toMatch(/3 consecutive rtk failures, last: rtk rewrite timed out/);
		expect(notices).toHaveLength(1);
		expect(statuses.at(-1)).toBe("RTK suspended");

		const before = calls.length;
		await controller.handleToolCall("bash", { command: "git status" }, cwd, undefined, reporter);
		expect(calls).toHaveLength(before);

		healthy = true;
		await controller.restart(reporter);
		const input = { command: "git status" };
		await controller.handleToolCall("bash", input, cwd, undefined, reporter);
		expect(input.command).toBe("rtk git status");
		expect(statuses.at(-1)).toBeUndefined();
	});

	it("resets the failure streak after a successful call", async () => {
		let n = 0;
		const { run } = fakeRtk(() => (n++ % 2 === 0 ? { ...missing } : exited(1)));
		const { controller, reporter } = await started(run);
		for (let i = 0; i < 6; i++) await controller.handleToolCall("bash", { command: "ls" }, cwd, undefined, reporter);
		expect(controller.suspended).toBeUndefined();
		expect(controller.counts.failed).toBe(3);
	});
});

describe("RtkController availability", () => {
	it("warns once and leaves commands alone when rtk is missing, then rechecks after a while", async () => {
		let installed = false;
		let time = 0;
		const { run, calls } = fakeRtk(
			(command) => exited(3, `rtk ${command}\n`),
			() => (installed ? exited(0, "rtk 1.0.1\n") : missing),
		);
		const { controller, reporter, notices, statuses } = await started(run, { now: () => time });
		expect(controller.availability).toEqual({
			ok: false,
			reason: "rtk --version could not run: ENOENT (is rtk installed and on PATH?)",
		});
		expect(notices).toHaveLength(1);
		expect(statuses.at(-1)).toBe("RTK unavailable");

		const input = { command: "git status" };
		await controller.handleToolCall("bash", input, cwd, undefined, reporter);
		expect(input.command).toBe("git status");
		expect(calls).toHaveLength(1);

		time = RECHECK_MS - 1;
		await controller.handleToolCall("bash", input, cwd, undefined, reporter);
		expect(calls).toHaveLength(1);

		time = RECHECK_MS;
		await controller.handleToolCall("bash", input, cwd, undefined, reporter);
		expect(calls).toHaveLength(2);
		expect(notices).toHaveLength(1);

		installed = true;
		time = 2 * RECHECK_MS;
		await controller.handleToolCall("bash", input, cwd, undefined, reporter);
		expect(input.command).toBe("rtk git status");
		expect(statuses.at(-1)).toBeUndefined();
	});

	it("rejects an rtk without `rewrite`", async () => {
		const { run } = fakeRtk(
			() => exited(1),
			() => exited(0, "rtk 0.22.9\n"),
		);
		const { controller } = await started(run);
		expect(controller.availability).toEqual({ ok: false, reason: "rtk 0.22.9 is too old (need 0.23.0 or newer)" });
	});
});

describe("checkVersion", () => {
	it("accepts 0.23.0 and newer", () => {
		expect(checkVersion("rtk 0.23.0")).toEqual({ ok: true, version: "0.23.0" });
		expect(checkVersion("rtk 1.0.1\n")).toEqual({ ok: true, version: "1.0.1" });
		expect(checkVersion("rtk 0.100.0")).toEqual({ ok: true, version: "0.100.0" });
		expect(checkVersion("rtk 0.22.99").ok).toBe(false);
		expect(checkVersion("rtk dev")).toEqual({ ok: true, version: "rtk dev" });
	});
});

describe("/rtk", () => {
	it("parses its arguments", () => {
		expect(parseRtkArgs("")).toEqual({ kind: "status" });
		expect(parseRtkArgs(" ON ")).toEqual({ kind: "on" });
		expect(parseRtkArgs("off")).toEqual({ kind: "off" });
		expect(parseRtkArgs("stats")).toEqual({ kind: "usage" });
	});

	it("reports state, tools, and counts", async () => {
		const { run } = fakeRtk((command) => exited(3, `rtk ${command}\n`));
		const { controller, reporter } = await started(run);
		await controller.handleToolCall("bash", { command: "git status" }, cwd, undefined, reporter);
		expect(formatStatus(controller, new Set(["bash"]))).toBe(
			[
				"pi-rtk",
				"  state: on",
				"  rtk: 1.0.1",
				"  tools: bash (command: command); exec_command (command: cmd, shell: shell, tty: tty, cwd: workdir) [not registered]",
				"  this session: 1 rewritten, 0 unchanged, 0 skipped, 0 blocked, 0 failed",
			].join("\n"),
		);
	});
});
