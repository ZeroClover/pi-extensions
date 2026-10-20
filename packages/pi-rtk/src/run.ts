import { execFile } from "node:child_process";
import type { RtkRun } from "./outcome.ts";

export interface RunOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeoutMs: number;
}

/** Runs a program without a shell and reports how it ended. */
export type Run = (file: string, args: string[], options: RunOptions) => Promise<RtkRun>;

const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * `execFile` rather than Pi's `pi.exec`: `pi.exec` reports a missing binary as exit code 1, which is also
 * "no rewrite", and a signal exit as code 0. Never rejects, including for arguments `execFile` refuses.
 */
export const runFile: Run = (file, args, options) =>
	new Promise((resolve) => {
		try {
			execFile(
				file,
				args,
				{
					cwd: options.cwd,
					signal: options.signal,
					timeout: options.timeoutMs,
					killSignal: "SIGKILL",
					maxBuffer: MAX_OUTPUT_BYTES,
					windowsHide: true,
					encoding: "utf8",
				},
				(error, stdout, stderr) => {
					const base = { stdout, stderr };
					if (error === null) {
						resolve({ ...base, code: 0, signal: null, timedOut: false });
						return;
					}
					// A timeout kills the process with killSignal and sets `killed`.
					if (error.killed && options.signal?.aborted !== true) {
						resolve({ ...base, code: null, signal: error.signal ?? null, timedOut: true });
						return;
					}
					if (typeof error.code === "number") {
						resolve({ ...base, code: error.code, signal: null, timedOut: false });
						return;
					}
					if (error.signal) {
						resolve({ ...base, code: null, signal: error.signal, timedOut: false });
						return;
					}
					// Spawn failures (ENOENT, EACCES, missing cwd), cancellation, and output over maxBuffer.
					const code = typeof error.code === "string" ? `${error.code}: ` : "";
					resolve({ ...base, code: null, signal: null, timedOut: false, error: `${code}${error.message}` });
				},
			);
		} catch (error) {
			// Invalid arguments, such as a NUL byte in the command, throw before the process starts.
			const message = error instanceof Error ? error.message : String(error);
			resolve({ stdout: "", stderr: "", code: null, signal: null, timedOut: false, error: message });
		}
	});
