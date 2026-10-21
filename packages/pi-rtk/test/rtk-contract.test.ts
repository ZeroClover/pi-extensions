import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { type Pi, reply, startPi, text, toolCall } from "../../../tools/e2e/src/index.ts";
import { type StubCall, stubTools } from "./fixtures.ts";

/** The real rtk on `PATH`, when it is new enough to have `rtk rewrite` (0.25.0); CI runners do not install it. */
function realRtk(): { version: string } | { missing: string } {
	const result = spawnSync("rtk", ["--version"], { encoding: "utf8" });
	if (result.status !== 0) return { missing: "rtk is not on PATH" };
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
	if (!match) return { missing: `rtk --version printed no version: ${result.stdout.trim()}` };
	const [major, minor] = [Number(match[1]), Number(match[2])];
	if (major === 0 && minor < 25) return { missing: `rtk ${match[0]} is older than 0.25.0` };
	return { version: match[0] };
}

const rtk = realRtk();
const title =
	"version" in rtk
		? `contract with the installed rtk ${rtk.version}`
		: `contract with the real rtk (skipped: ${rtk.missing})`;

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

describe.skipIf(!("version" in rtk))(title, () => {
	// command-rewriting: Exit-code contract, Rewrite before execution ("Command that looks like an option").
	it("rewrites what rtk supports and leaves editors, option-like commands, and rtk commands as the model wrote them", async () => {
		const calls: StubCall[] = [];
		pi = await startPi({ extensions: ["pi-rtk"], tools: ["exec_command"], customTools: stubTools(calls) });
		const runs = async (cmd: string): Promise<unknown> => {
			pi?.provider.respond(reply(toolCall("exec_command", { cmd })), reply(text("ok")));
			await pi?.prompt(`run ${cmd}`);
			const { cmd: ran } = calls.at(-1)?.input ?? {};
			return ran;
		};

		expect(await runs("git status")).toBe("rtk git status");
		for (const cmd of ["vim notes.txt", "-h", "--help", "rtk git status"]) expect(await runs(cmd)).toBe(cmd);
	});
});
