import { MIN_SETTLED_SPAN_MS } from "./constants.ts";
import {
	type Aggregate,
	parseRunRecord,
	type RequestRecord,
	type RunRecord,
	type RunSummary,
	type SessionSummary,
	TELEMETRY_CUSTOM_TYPE,
} from "./telemetry.ts";

/** The fields of a session entry that reconstruction reads. */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Run records of this package on a branch, oldest first. Foreign and unknown entries are skipped. */
export function runsFromEntries(entries: readonly EntryLike[]): RunRecord[] {
	const runs: RunRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TELEMETRY_CUSTOM_TYPE) continue;
		const run = parseRunRecord(entry.data);
		if (run) runs.push(run);
	}
	return runs;
}

/** Output tokens of a request without its thinking tokens. */
export function visibleOutput(record: RequestRecord): number {
	return Math.max(0, record.outputTokens - (record.thinkingTokens ?? 0));
}

/**
 * Whether a request's output rate describes genuine streaming: settled or aborted, not burst, and with at least 1 s
 * of active output. Shorter spans (typically tool-call requests) are dominated by tokens the provider counts but never
 * streams, such as tool-call framing, and would inflate the aggregate.
 */
function hasRate(record: RequestRecord): boolean {
	return !record.burst && record.outputMs >= MIN_SETTLED_SPAN_MS;
}

/** Summed visible output over summed active output span, with whether any of the requests relied on the estimate. */
function weightedRate(records: readonly RequestRecord[]): { tps: number; estimated: boolean } | undefined {
	let tokens = 0;
	let ms = 0;
	let estimated = false;
	for (const record of records) {
		tokens += visibleOutput(record);
		ms += record.outputMs;
		if (record.estimated) estimated = true;
	}
	return ms > 0 ? { tps: tokens / (ms / 1000), estimated } : undefined;
}

function meanTtft(records: readonly RequestRecord[]): number | undefined {
	const values = records.flatMap((record) => (record.ttftMs === undefined ? [] : [record.ttftMs]));
	return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Aggregates request records with one method for runs and sessions, so their figures cannot disagree:
 * - TPS: the aggregate generation rate, summed visible output over summed active output span of the non-burst requests
 *   with at least 1 s of active output (the per-request rates weighted by their active duration). Aborted requests
 *   count only when nothing else qualifies, so an aborted run still shows a rate.
 * - Burst throughput: only when every request was a burst, i.e. the whole answer was buffered.
 * - TTFT: mean over non-aborted requests, falling back to aborted ones the same way.
 * - Everything else: sums over all requests.
 */
export function aggregate(records: readonly RequestRecord[]): Aggregate {
	const result: Aggregate = {
		requests: records.length,
		estimated: false,
		tokensEstimated: false,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		visibleOutputTokens: 0,
		thinkingTokens: 0,
		thinkingMs: 0,
		stallMs: 0,
		stallCount: 0,
	};
	for (const record of records) {
		result.inputTokens += record.inputTokens;
		result.cacheReadTokens += record.cacheReadTokens;
		result.cacheWriteTokens += record.cacheWriteTokens;
		result.visibleOutputTokens += visibleOutput(record);
		result.thinkingTokens += record.thinkingTokens ?? 0;
		result.thinkingMs += record.thinkingMs ?? 0;
		result.stallMs += record.stallMs;
		result.stallCount += record.stallCount;
		if (record.cost !== undefined) result.cost = (result.cost ?? 0) + record.cost;
		if (record.estimated) result.tokensEstimated = true;
	}

	const completed = records.filter((record) => record.outcome === "settled");
	const aborted = records.filter((record) => record.outcome === "aborted");
	const settledRated = completed.filter(hasRate);
	const rated = settledRated.length > 0 ? settledRated : aborted.filter(hasRate);
	const rate = weightedRate(rated);
	if (rate) {
		result.tps = rate.tps;
		result.estimated = rate.estimated;
	} else if (records.length > 0 && records.every((record) => record.burst)) {
		const tokens = records.reduce((sum, record) => sum + record.outputTokens, 0);
		const ms = records.reduce((sum, record) => sum + record.elapsedMs, 0);
		if (ms > 0) {
			result.burstTps = tokens / (ms / 1000);
			result.estimated = records.some((record) => record.estimated);
		}
	}
	const ttftMs = meanTtft(completed) ?? meanTtft(aborted);
	if (ttftMs !== undefined) result.ttftMs = ttftMs;

	const colourSource = rated.at(-1) ?? records.at(-1);
	if (colourSource) {
		result.provider = colourSource.provider;
		result.model = colourSource.model;
	}
	return result;
}

export function summarizeRun(run: RunRecord): RunSummary {
	return { ...aggregate(run.requests), elapsedMs: run.elapsedMs, aborted: run.aborted };
}

/** Session figures over every run on the branch; undefined without runs. */
export function summarizeSession(runs: readonly RunRecord[]): SessionSummary | undefined {
	if (runs.length === 0) return undefined;
	return { ...aggregate(runs.flatMap((run) => run.requests)), runs: runs.length };
}
