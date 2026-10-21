import { access, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Pi, reply, startPi, text, toolCall } from "../../../tools/e2e/src/index.ts";
import { type FakeRtk, fakeRtk, MARKER, type RewriteMode, type StubCall, stubTools } from "./fixtures.ts";

let pi: Pi | undefined;
let rtk: FakeRtk | undefined;

afterEach(async () => {
	await pi?.dispose();
	await rtk?.bin.remove();
	pi = undefined;
	rtk = undefined;
});

async function start(calls: StubCall[] = []): Promise<Pi> {
	rtk ??= await fakeRtk();
	pi = await startPi({
		extensions: ["pi-rtk"],
		env: { PATH: rtk.bin.path() },
		tools: ["bash", "exec_command", "bg_run"],
		customTools: stubTools(calls),
	});
	return pi;
}

describe("rewrite before execution", () => {
	// command-rewriting: Rewrite before execution. tool-adapters: Built-in adapters, Working directory.
	it("runs RTK's rewrite instead of the model's command, in the field and directory each tool uses", async () => {
		const calls: StubCall[] = [];
		const session = await start(calls);
		const workdir = join(session.cwd, "sub");
		await mkdir(workdir);
		session.provider.respond(
			reply(toolCall("bash", { command: "git status" })),
			reply(toolCall("exec_command", { cmd: "git log", workdir: "sub" })),
			reply(text("done")),
		);
		await session.prompt("go");

		const [bashResult] = session.toolResults();
		expect(bashResult).toContain(`${MARKER} git status`);
		expect(calls).toEqual([{ tool: "exec_command", input: { cmd: "rtk git log", workdir: "sub" } }]);
		const rewrites = (await rtk?.calls())?.filter((call) => call.args.startsWith("rewrite"));
		expect(rewrites?.map((call) => call.args)).toEqual(["rewrite -- git status", "rewrite -- git log"]);
		expect(await realpath(rewrites?.[1]?.cwd ?? "")).toBe(await realpath(workdir));
	});
});

describe("exit-code contract", () => {
	// command-rewriting: Exit-code contract.
	it("blocks a deny with a message instead of running it, and runs the command for a silent deny or no equivalent", async () => {
		const session = await start();
		const ran = async (file: string): Promise<boolean> =>
			await access(join(session.cwd, file)).then(
				() => true,
				() => false,
			);
		const runOnce = async (mode: RewriteMode, file: string): Promise<string | undefined> => {
			await rtk?.mode(mode);
			session.provider.respond(
				reply(toolCall("bash", { command: `touch ${file} && echo made ${file}` })),
				reply(text("ok")),
			);
			await session.prompt(`run ${file}`);
			return session.toolResults().at(-1);
		};

		expect(await runOnce("deny-message", "denied")).toContain("rtk: blocked by the test policy");
		expect(await ran("denied")).toBe(false);
		expect(await runOnce("deny-silent", "deferred")).toContain("made deferred");
		expect(await ran("deferred")).toBe(true);
		expect(await runOnce("no-equivalent", "plain")).toContain("made plain");
		expect(await ran("plain")).toBe(true);
	});
});

describe("skip rules", () => {
	// tool-adapters: Skip rules.
	it("hands interactive, non-POSIX, already-RTK, and missing-directory commands to the tool byte-identical", async () => {
		const calls: StubCall[] = [];
		const session = await start(calls);
		const inputs = [
			{ cmd: "git status", tty: true },
			{ cmd: "git status", shell: "pwsh" },
			{ cmd: "git status", shell: false },
			{ cmd: "rtk git status" },
			{ cmd: "git status", workdir: "missing" },
		];
		session.provider.respond(reply(inputs.map((input) => toolCall("exec_command", input))), reply(text("done")));
		await session.prompt("go");

		expect(calls.map((call) => call.input)).toEqual(expect.arrayContaining(inputs));
		expect(calls).toHaveLength(inputs.length);
		expect((await rtk?.calls())?.filter((call) => call.args.startsWith("rewrite"))).toEqual([]);
	});
});
