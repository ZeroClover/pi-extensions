import { tokensEstimated, visibleOutput } from "./aggregate.ts";
import type { Clock } from "./clock.ts";
import { type RequestRecord, type RunRecord, TELEMETRY_VERSION, type WorkingSnapshot } from "./telemetry.ts";

interface ActiveRun {
	startAt: number;
	startedAt: number;
	requests: RequestRecord[];
}

/**
 * Tracks the agent run in progress: from the first `agent_start` after the previous run settled to `agent_settled`.
 * Retries, compaction and queued continuations start further agent loops inside the same run.
 */
export class RunTracker {
	private run: ActiveRun | undefined;

	constructor(private readonly clock: Clock) {}

	get active(): boolean {
		return this.run !== undefined;
	}

	/** Number of requests recorded in the active run. */
	get requestCount(): number {
		return this.run?.requests.length ?? 0;
	}

	/** Starts a run unless one is active. Returns true when a new run started. */
	start(wallTime: number): boolean {
		if (this.run) return false;
		this.run = { startAt: this.clock.now(), startedAt: wallTime, requests: [] };
		return true;
	}

	add(record: RequestRecord): void {
		this.run?.requests.push(record);
	}

	/** Progress of the active run between requests. */
	snapshot(): WorkingSnapshot | undefined {
		const run = this.run;
		if (!run) return undefined;
		return {
			phase: "working",
			elapsedMs: this.clock.now() - run.startAt,
			requests: run.requests.length,
			outputTokens: run.requests.reduce((sum, record) => sum + visibleOutput(record), 0),
			estimated: run.requests.some(tokensEstimated),
		};
	}

	/** Ends the active run. Returns its record, or undefined when no run was active or it measured no request. */
	settle(aborted: boolean): RunRecord | undefined {
		const run = this.run;
		this.run = undefined;
		if (!run || run.requests.length === 0) return undefined;
		return {
			version: TELEMETRY_VERSION,
			startedAt: run.startedAt,
			elapsedMs: Math.round(this.clock.now() - run.startAt),
			aborted,
			requests: run.requests,
		};
	}

	discard(): void {
		this.run = undefined;
	}
}
