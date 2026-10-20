/** How an rtk process ended. */
export interface RtkRun {
	/** Exit code, or null when the process did not exit normally. */
	code: number | null;
	/** Terminating signal when the process was killed. */
	signal: string | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Set when the process could not be started or was cancelled, for example a missing binary. */
	error?: string;
}

/** What `rtk rewrite <command>` decided for one command. */
export type RewriteOutcome =
	| { kind: "rewrite"; command: string }
	| { kind: "unchanged" }
	| { kind: "block"; reason: string }
	| { kind: "failure"; reason: string };

function firstLine(text: string): string {
	return text.trim().split("\n", 1)[0] ?? "";
}

/** Why an rtk process did not complete with an exit code, or undefined when it did. */
export function runFailure(name: string, run: RtkRun): string | undefined {
	if (run.timedOut) return `${name} timed out`;
	if (run.error !== undefined) return `${name} could not run: ${run.error}`;
	if (run.code === null) return `${name} was killed${run.signal === null ? "" : ` by ${run.signal}`}`;
	return undefined;
}

/**
 * Maps the exit-code contract of `rtk rewrite` to an outcome:
 * 0 and 3 print a rewrite (3 only defers permission to the host, which Pi does not have);
 * 1 means no RTK equivalent; 2 is a deny, which blocks only when RTK printed a message,
 * because without one it defers to the host's own deny rules. Anything else is a failure.
 */
export function interpretRewrite(original: string, run: RtkRun): RewriteOutcome {
	const failure = runFailure("rtk rewrite", run);
	if (failure !== undefined) return { kind: "failure", reason: failure };
	switch (run.code) {
		case 0:
		case 3: {
			const rewritten = run.stdout.trim();
			if (rewritten === "" || rewritten === original.trim()) return { kind: "unchanged" };
			return { kind: "rewrite", command: rewritten };
		}
		case 1:
			return { kind: "unchanged" };
		case 2: {
			const message = run.stdout.trim();
			return message === "" ? { kind: "unchanged" } : { kind: "block", reason: message };
		}
		default: {
			const detail = firstLine(run.stderr);
			return {
				kind: "failure",
				reason: `rtk rewrite exited with code ${run.code}${detail === "" ? "" : `: ${detail}`}`,
			};
		}
	}
}
