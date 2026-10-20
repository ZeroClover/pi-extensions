import { stat } from "node:fs/promises";
import { resolveTarget, type ToolAdapter } from "./adapters.ts";
import { firstLine, interpretRewrite, runFailure } from "./outcome.ts";
import type { Run } from "./run.ts";

export interface Reporter {
	notify(message: string, level: "info" | "warning"): void;
	setStatus(text: string | undefined): void;
}

export const STATUS_KEY = "rtk";
export const RTK_BIN = "rtk";
export const TIMEOUT_MS = 2000;
/** Consecutive rtk failures (timeouts, crashes, a vanished binary) that suspend rewriting for the session. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** How long an unavailable rtk is trusted before the next tool call checks again. */
export const RECHECK_MS = 30_000;
/** `rtk rewrite` first shipped in 0.23.0. */
const MIN_VERSION: readonly [number, number, number] = [0, 23, 0];

export type Availability = { ok: true; version: string } | { ok: false; reason: string };

export interface Counts {
	rewritten: number;
	unchanged: number;
	skipped: number;
	blocked: number;
	failed: number;
}

function emptyCounts(): Counts {
	return { rewritten: 0, unchanged: 0, skipped: 0, blocked: 0, failed: 0 };
}

/** Reads `rtk X.Y.Z` and checks it against the minimum; output without a version is accepted as is. */
export function checkVersion(output: string): Availability {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
	if (!match) return { ok: true, version: output.trim() || "unknown" };
	const version = [Number(match[1]), Number(match[2]), Number(match[3])];
	const text = version.join(".");
	for (let i = 0; i < MIN_VERSION.length; i++) {
		const have = version[i] ?? 0;
		const need = MIN_VERSION[i] ?? 0;
		if (have > need) break;
		if (have < need) return { ok: false, reason: `rtk ${text} is too old (need ${MIN_VERSION.join(".")} or newer)` };
	}
	return { ok: true, version: text };
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export interface ControllerOptions {
	run: Run;
	/** Reads an environment variable of Pi's process. */
	getEnv?: (name: string) => string | undefined;
	now?: () => number;
}

export class RtkController {
	adapters = new Map<string, ToolAdapter>();
	availability: Availability = { ok: false, reason: "not checked yet" };
	/** False after `/rtk off`; every session starts on. */
	enabled = true;
	/** Why rewriting stopped after repeated rtk failures, until `/rtk on` or the next session. */
	suspended: string | undefined;
	lastFailure: string | undefined;
	counts = emptyCounts();
	private consecutiveFailures = 0;
	private checkedAt = 0;
	private readonly run: Run;
	private readonly getEnv: (name: string) => string | undefined;
	private readonly now: () => number;

	constructor(options: ControllerOptions) {
		this.run = options.run;
		this.getEnv = options.getEnv ?? ((name) => process.env[name]);
		this.now = options.now ?? Date.now;
	}

	/** True when `RTK_DISABLED=1` is set in Pi's environment, RTK's own off switch. */
	get disabledByEnv(): boolean {
		return this.getEnv("RTK_DISABLED") === "1";
	}

	/** Resets the per-session state and checks for a usable rtk binary. */
	async start(adapters: Map<string, ToolAdapter>, reporter: Reporter): Promise<void> {
		this.adapters = adapters;
		this.enabled = true;
		this.counts = emptyCounts();
		await this.restart(reporter);
	}

	/** Clears a suspension and checks rtk again; used by `/rtk on` and at session start. */
	async restart(reporter: Reporter): Promise<void> {
		this.suspended = undefined;
		this.lastFailure = undefined;
		this.consecutiveFailures = 0;
		// RTK's own switch is fixed for the process: nothing will run rtk, so there is nothing to check or warn about.
		if (this.disabledByEnv) {
			reporter.setStatus(this.statusText());
			return;
		}
		await this.check(reporter, true);
	}

	setEnabled(enabled: boolean, reporter: Reporter): void {
		this.enabled = enabled;
		reporter.setStatus(this.statusText());
	}

	/** Footer text while commands are not being rewritten; undefined while RTK is active. */
	statusText(): string | undefined {
		if (!this.enabled || this.disabledByEnv) return "RTK off";
		if (!this.availability.ok) return "RTK unavailable";
		if (this.suspended !== undefined) return "RTK suspended";
		return undefined;
	}

	private async check(reporter: Reporter, announce: boolean): Promise<void> {
		const wasOk = this.availability.ok;
		// Set before the probe so that parallel tool calls do not each start a recheck.
		this.checkedAt = this.now();
		this.availability = await this.probe();
		if (!this.availability.ok && (announce || wasOk)) {
			reporter.notify(`pi-rtk: commands run unchanged: ${this.availability.reason}`, "warning");
		}
		reporter.setStatus(this.statusText());
	}

	private async probe(): Promise<Availability> {
		const run = await this.run(RTK_BIN, ["--version"], { timeoutMs: TIMEOUT_MS });
		const failure = runFailure("rtk --version", run);
		if (failure !== undefined) return { ok: false, reason: `${failure} (is rtk installed and on PATH?)` };
		if (run.code !== 0) {
			const detail = firstLine(run.stderr);
			return { ok: false, reason: `rtk --version exited with code ${run.code}${detail === "" ? "" : `: ${detail}`}` };
		}
		return checkVersion(run.stdout);
	}

	/**
	 * Rewrites the command in `input` in place when the tool has an adapter and RTK has an equivalent. Returns a
	 * block when RTK denies the command with a message; every other problem leaves the command unchanged.
	 */
	async handleToolCall(
		toolName: string,
		input: Record<string, unknown>,
		cwd: string,
		signal: AbortSignal | undefined,
		reporter: Reporter,
	): Promise<{ block: true; reason: string } | undefined> {
		const adapter = this.adapters.get(toolName);
		if (!adapter || !this.enabled || this.suspended !== undefined || this.disabledByEnv) return undefined;
		if (!this.availability.ok) {
			if (this.now() - this.checkedAt < RECHECK_MS) return undefined;
			await this.check(reporter, false);
			if (!this.availability.ok) return undefined;
		}
		const target = resolveTarget(adapter, input, cwd);
		// A missing working directory is the tool's error to report, not rtk's.
		if (target.kind === "skip" || !(await isDirectory(target.cwd))) {
			this.counts.skipped++;
			return undefined;
		}

		// `--` keeps a command such as `-h` from being parsed as an rtk option, whose help text would become the rewrite.
		const run = await this.run(RTK_BIN, ["rewrite", "--", target.command], {
			cwd: target.cwd,
			timeoutMs: TIMEOUT_MS,
			...(signal ? { signal } : {}),
		});
		// The tool call is being cancelled; that is not a fault of rtk.
		if (signal?.aborted) return undefined;

		const outcome = interpretRewrite(target.command, run);
		if (outcome.kind === "failure") {
			this.recordFailure(outcome.reason, reporter);
			return undefined;
		}
		this.consecutiveFailures = 0;
		switch (outcome.kind) {
			case "rewrite":
				input[adapter.commandField] = outcome.command;
				this.counts.rewritten++;
				return undefined;
			case "unchanged":
				this.counts.unchanged++;
				return undefined;
			case "block":
				this.counts.blocked++;
				return { block: true, reason: `rtk: ${outcome.reason}` };
		}
	}

	private recordFailure(reason: string, reporter: Reporter): void {
		this.counts.failed++;
		this.lastFailure = reason;
		this.consecutiveFailures++;
		if (this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES || this.suspended !== undefined) return;
		this.suspended = `${MAX_CONSECUTIVE_FAILURES} consecutive rtk failures, last: ${reason}`;
		reporter.notify(
			`pi-rtk: suspended for this session after ${this.suspended}; commands run unchanged. /rtk on retries.`,
			"warning",
		);
		reporter.setStatus(this.statusText());
	}
}
