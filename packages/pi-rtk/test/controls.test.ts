import { afterEach, describe, expect, it } from "vitest";
import { type Pi, reply, type StartOptions, startPi, text, toolCall } from "../../../tools/e2e/src/index.ts";
import { type FakeRtk, fakeRtk, MARKER, pathWithoutRtk, type StubCall, stubTools } from "./fixtures.ts";

const STATUS_KEY = "rtk";

let pi: Pi | undefined;
let rtk: FakeRtk | undefined;

afterEach(async () => {
	await pi?.dispose();
	await rtk?.bin.remove();
	pi = undefined;
	rtk = undefined;
});

async function start(options: Partial<StartOptions> = {}, calls: StubCall[] = []): Promise<Pi> {
	rtk ??= await fakeRtk();
	pi = await startPi({
		extensions: ["pi-rtk"],
		tools: ["bash", "exec_command", "bg_run"],
		customTools: stubTools(calls),
		...options,
		env: { PATH: rtk.bin.path(), ...options.env },
	});
	return pi;
}

/** Lets the model call `bash` once with `command`, and returns the tool result the model received. */
async function bash(session: Pi, command: string): Promise<string | undefined> {
	session.provider.respond(reply(toolCall("bash", { command })), reply(text("ok")));
	await session.prompt(`run ${command}`);
	return session.toolResults().at(-1);
}

function warnings(session: Pi, fragment: string): string[] {
	return session.ui.notices
		.filter((notice) => notice.level === "warning" && notice.message.includes(fragment))
		.map((notice) => notice.message);
}

function lastNotice(session: Pi): string {
	return session.ui.notices.at(-1)?.message ?? "";
}

async function rewriteCalls(): Promise<number> {
	return ((await rtk?.calls()) ?? []).filter((call) => call.args.startsWith("rewrite")).length;
}

describe("fail open", () => {
	// command-rewriting: Fail open. rtk-availability: Check at session start.
	it("runs commands unchanged with one warning when rtk is not installed", async () => {
		const session = await start({ env: { PATH: pathWithoutRtk() } });

		expect(await bash(session, "echo plain")).toContain("plain");
		expect(warnings(session, "commands run unchanged")).toHaveLength(1);
		expect(session.ui.currentStatus(STATUS_KEY)).toBe("RTK unavailable");
	});

	// command-rewriting: Fail open. rtk-availability: Suspend after repeated failures.
	it("keeps a hung rtk from blocking commands, suspends it after three timeouts, and resumes on /rtk on", async () => {
		const session = await start();
		await rtk?.mode("hang");
		session.provider.respond(
			reply([1, 2, 3].map((n) => toolCall("bash", { command: `echo unchanged ${n}` }))),
			reply(text("ok")),
		);
		await session.prompt("three commands");

		expect(session.toolResults().join("\n")).toMatch(/unchanged 1[\s\S]*unchanged 2[\s\S]*unchanged 3/);
		expect(warnings(session, "suspended for this session")).toHaveLength(1);
		expect(session.ui.currentStatus(STATUS_KEY)).toBe("RTK suspended");
		expect(await bash(session, "echo after suspension")).toContain("after suspension");
		expect(await rewriteCalls()).toBe(3);

		await rtk?.mode("rewrite");
		await session.prompt("/rtk on");
		expect(session.ui.currentStatus(STATUS_KEY)).toBeUndefined();
		expect(await bash(session, "git status")).toContain(`${MARKER} git status`);
	});
});

describe("controls", () => {
	// rewrite-controls: Session switch, Status command, Footer status.
	it("turns rewriting off and on for the session, reports it, and starts every new session on", async () => {
		const session = await start();
		expect(session.ui.currentStatus(STATUS_KEY)).toBeUndefined();

		await session.prompt("/rtk off");
		expect(session.ui.currentStatus(STATUS_KEY)).toBe("RTK off");
		expect(await bash(session, "echo while off")).toContain("while off");
		await session.prompt("/rtk");
		expect(lastNotice(session)).toContain("state: off (/rtk off)");

		await session.prompt("/rtk on");
		expect(session.ui.currentStatus(STATUS_KEY)).toBeUndefined();
		expect(await bash(session, "git status")).toContain(`${MARKER} git status`);
		await session.prompt("/rtk");
		const report = lastNotice(session);
		expect(report).toContain("state: on");
		expect(report).toContain("rtk: 0.30.0");
		expect(report).toContain("exec_command (command: cmd, shell: shell, tty: tty, cwd: workdir)");
		expect(report).toContain("this session: 1 rewritten, 0 unchanged, 0 skipped, 0 blocked, 0 failed");

		await session.prompt("/rtk off");
		await session.runtime.newSession();
		expect(session.ui.currentStatus(STATUS_KEY)).toBeUndefined();
		expect(await bash(session, "git log")).toContain(`${MARKER} git log`);
	});

	// rewrite-controls: Environment switch, Footer status, Status command.
	it("never runs rtk under RTK_DISABLED=1, and says so when /rtk on is asked for", async () => {
		const session = await start({ env: { RTK_DISABLED: "1" }, tools: ["bash"], customTools: [] });

		expect(await bash(session, "echo untouched")).toContain("untouched");
		expect(await rtk?.calls()).toEqual([]);
		expect(session.ui.currentStatus(STATUS_KEY)).toBe("RTK off");
		await session.prompt("/rtk");
		expect(lastNotice(session)).toContain("state: off (RTK_DISABLED=1)");
		expect(lastNotice(session)).toContain(
			"exec_command (command: cmd, shell: shell, tty: tty, cwd: workdir) [not registered]",
		);
		await session.prompt("/rtk on");
		expect(warnings(session, "RTK_DISABLED=1 in Pi's environment keeps rewriting off")).toHaveLength(1);
		expect(await bash(session, "echo still untouched")).toContain("still untouched");
		expect(await rtk?.calls()).toEqual([]);
	});
});

describe("configured adapters", () => {
	// tool-adapters: Configured adapters.
	it("adds and removes tools from pi-rtk.json, and keeps the built-in guard when an entry has a typo", async () => {
		const calls: StubCall[] = [];
		const config = {
			tools: {
				bg_run: { commandField: "command" },
				bash: false,
				exec_command: { commandField: "cmd", ttyFeld: "tty" },
			},
		};
		const session = await start({ agentFiles: { "pi-rtk.json": config } }, calls);
		expect(warnings(session, "tools.exec_command.ttyFeld: unknown setting; entry ignored")).toHaveLength(1);

		session.provider.respond(
			reply([
				toolCall("bg_run", { command: "git status" }),
				toolCall("bash", { command: "echo bash is unchanged" }),
				toolCall("exec_command", { cmd: "git status", tty: true }),
			]),
			reply(text("ok")),
		);
		await session.prompt("go");

		expect(calls).toEqual(
			expect.arrayContaining([
				{ tool: "bg_run", input: { command: "rtk git status" } },
				{ tool: "exec_command", input: { cmd: "git status", tty: true } },
			]),
		);
		expect(session.toolResults().join("\n")).toContain("bash is unchanged");
		expect(await rewriteCalls()).toBe(1);
	});
});
