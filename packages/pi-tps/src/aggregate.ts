import {
	parseRunRecord,
	type RequestRecord,
	type RunRecord,
	type SessionTotals,
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

/** Sums over every run and request on the branch, aborted and burst ones included; undefined without runs. */
export function sessionTotals(runs: readonly RunRecord[]): SessionTotals | undefined {
	const last = runs.at(-1);
	if (!last) return undefined;
	const totals: SessionTotals = {
		runs: runs.length,
		elapsedMs: 0,
		requests: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		visibleOutputTokens: 0,
		thinkingTokens: 0,
		lastAborted: last.aborted,
	};
	for (const run of runs) {
		totals.elapsedMs += run.elapsedMs;
		totals.requests += run.requests.length;
		for (const record of run.requests) {
			totals.inputTokens += record.inputTokens;
			totals.cacheReadTokens += record.cacheReadTokens;
			totals.cacheWriteTokens += record.cacheWriteTokens;
			totals.visibleOutputTokens += visibleOutput(record);
			totals.thinkingTokens += record.thinkingTokens ?? 0;
			if (record.cost !== undefined) totals.cost = (totals.cost ?? 0) + record.cost;
		}
	}
	return totals;
}
