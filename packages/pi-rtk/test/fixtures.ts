import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type TempBin, tempBin } from "../../../tools/e2e/src/index.ts";

const run = promisify(execFile);

/** How the fake `rtk rewrite` answers. */
export type RewriteMode = "rewrite" | "deny-message" | "deny-silent" | "no-equivalent" | "hang";

/** Printed by the fake when it runs a rewritten command, so a tool result shows that the rewrite was executed. */
export const MARKER = "FAKE-RTK-RAN";

/**
 * A stand-in for rtk 0.30 on `PATH`. It logs every invocation with its working directory, answers `--version`, answers
 * `rewrite` as its mode file says, and when run as `rtk <command>` prints the marker and the command.
 */
const SCRIPT = `#!/bin/sh
here=$(dirname "$0")
printf '%s\\t%s\\n' "$PWD" "$*" >> "$here/rtk.log"
if [ "$1" = "--version" ]; then
	echo "rtk 0.30.0"
	exit 0
fi
if [ "$1" = "rewrite" ]; then
	[ "$2" = "--" ] && shift
	shift
	mode=$(cat "$here/rtk.mode" 2>/dev/null || echo rewrite)
	case "$mode" in
		rewrite) echo "rtk $*"; exit 3 ;;
		deny-message) echo "blocked by the test policy"; exit 2 ;;
		deny-silent) exit 2 ;;
		no-equivalent) exit 1 ;;
		hang) exec sleep 5 ;;
	esac
	exit 9
fi
echo "${MARKER} $*"
`;

export interface FakeRtk {
	readonly bin: TempBin;
	/** Sets how the following `rtk rewrite` calls answer. */
	mode(mode: RewriteMode): Promise<void>;
	/** Every invocation so far: the working directory and the arguments. */
	calls(): Promise<{ cwd: string; args: string }[]>;
}

export async function fakeRtk(mode: RewriteMode = "rewrite"): Promise<FakeRtk> {
	const bin = await tempBin();
	const file = await bin.write("rtk", SCRIPT);
	// The first run of a new executable can be slow (macOS scans it); pay that here, not inside pi-rtk's 2 s timeout.
	await run(file, ["--version"]);
	await rm(join(bin.dir, "rtk.log"));
	const fake: FakeRtk = {
		bin,
		mode: (next) => writeFile(join(bin.dir, "rtk.mode"), `${next}\n`),
		calls: async () => {
			let text = "";
			try {
				text = await readFile(join(bin.dir, "rtk.log"), "utf8");
			} catch {
				return [];
			}
			return text
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => {
					const [cwd = "", args = ""] = line.split("\t");
					return { cwd, args };
				});
		},
	};
	await fake.mode(mode);
	return fake;
}

/** What a stub tool received, after every `tool_call` handler ran. */
export interface StubCall {
	tool: string;
	input: Record<string, unknown>;
}

/**
 * Stand-ins for pi-unified-exec's `exec_command` and pi-background-tasks' `bg_run`, with their input fields. They
 * record what they would run instead of running it.
 */
export function stubTools(calls: StubCall[]): ToolDefinition[] {
	const execCommand = defineTool({
		name: "exec_command",
		label: "Exec",
		description: "Run a command",
		parameters: Type.Object({
			cmd: Type.String({ description: "Command" }),
			workdir: Type.Optional(Type.String({ description: "Working directory" })),
			shell: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "Shell" })),
			tty: Type.Optional(Type.Boolean({ description: "PTY" })),
		}),
		async execute(_id, params) {
			calls.push({ tool: "exec_command", input: { ...params } });
			return { content: [{ type: "text", text: `exec_command ran: ${params.cmd}` }], details: undefined };
		},
	});
	const bgRun = defineTool({
		name: "bg_run",
		label: "Background",
		description: "Run a command in the background",
		parameters: Type.Object({ command: Type.String({ description: "Command" }) }),
		async execute(_id, params) {
			calls.push({ tool: "bg_run", input: { ...params } });
			return { content: [{ type: "text", text: `bg_run ran: ${params.command}` }], details: undefined };
		},
	});
	return [execCommand, bgRun];
}

/** `PATH` without any directory that holds an `rtk`, so that rtk is missing for the session. */
export function pathWithoutRtk(): string {
	const { PATH = "" } = process.env;
	return PATH.split(delimiter)
		.filter((dir) => dir !== "" && !existsSync(join(dir, "rtk")))
		.join(delimiter);
}
