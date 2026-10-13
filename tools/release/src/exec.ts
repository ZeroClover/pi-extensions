import { spawn } from "node:child_process";

export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface CommandOptions {
	readonly cwd?: string | undefined;
	readonly input?: string | undefined;
	readonly env?: NodeJS.ProcessEnv | undefined;
}

/** The single seam for processes: production spawns them, tests substitute small doubles. */
export type Runner = (command: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

export const runCommand: Runner = (command, args, options = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			// A child that exits without reading its input closes the pipe; that is not a failure.
			if (error.code !== "EPIPE") {
				reject(error);
			}
		});
		child.on("error", reject);
		child.on("close", (code) =>
			resolve({
				code: code ?? 1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		);
		child.stdin.end(options.input ?? "");
	});

/** Runs a command and returns its stdout, or throws with its output when it exits non-zero. */
export async function runChecked(
	run: Runner,
	command: string,
	args: readonly string[],
	options?: CommandOptions,
): Promise<string> {
	const result = await run(command, args, options);
	if (result.code !== 0) {
		const output = (result.stderr.trim() || result.stdout.trim()).slice(-4000);
		throw new Error(`${command} ${args.join(" ")} exited with ${result.code}${output === "" ? "" : `: ${output}`}`);
	}
	return result.stdout;
}
