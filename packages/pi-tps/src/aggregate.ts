import { parseRecord, type SessionAggregate, TELEMETRY_CUSTOM_TYPE, type TelemetryRecord } from "./telemetry.ts";

/** The fields of a session entry that reconstruction reads. */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Telemetry records of this package on a branch, oldest first. Foreign and unknown entries are skipped. */
export function recordsFromEntries(entries: readonly EntryLike[]): TelemetryRecord[] {
	const records: TelemetryRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TELEMETRY_CUSTOM_TYPE) continue;
		const record = parseRecord(entry.data);
		if (record) records.push(record);
	}
	return records;
}

/** Whether a record's output TPS describes genuine streaming. */
export function countsTowardAverages(record: TelemetryRecord): boolean {
	return record.outcome === "settled" && !record.burst;
}

function mean(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Session aggregates, recomputed from the records so that branch changes are a plain recompute. */
export function aggregate(records: readonly TelemetryRecord[]): SessionAggregate | undefined {
	if (records.length === 0) return undefined;
	const ttft: number[] = [];
	const outputTps: number[] = [];
	const thinkingTps: number[] = [];
	const result: SessionAggregate = {
		count: records.length,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	for (const record of records) {
		if (record.ttftMs !== undefined) ttft.push(record.ttftMs);
		if (countsTowardAverages(record)) {
			if (record.outputTps !== undefined) outputTps.push(record.outputTps);
			if (record.thinkingTps !== undefined) thinkingTps.push(record.thinkingTps);
		}
		result.inputTokens += record.inputTokens;
		result.outputTokens += record.outputTokens;
		result.cacheReadTokens += record.cacheReadTokens;
		result.cacheWriteTokens += record.cacheWriteTokens;
		if (record.cost !== undefined) result.cost = (result.cost ?? 0) + record.cost;
	}
	const meanTtftMs = mean(ttft);
	if (meanTtftMs !== undefined) result.meanTtftMs = meanTtftMs;
	const meanOutputTps = mean(outputTps);
	if (meanOutputTps !== undefined) result.meanOutputTps = meanOutputTps;
	const meanThinkingTps = mean(thinkingTps);
	if (meanThinkingTps !== undefined) result.meanThinkingTps = meanThinkingTps;
	return result;
}

/**
 * The last record, plus the output TPS of the most recent earlier request that had one when the last record is
 * a settled stream too short to have its own.
 */
export function lastRecord(
	records: readonly TelemetryRecord[],
): { record: TelemetryRecord; fallbackTps?: number } | undefined {
	const record = records.at(-1);
	if (!record) return undefined;
	if (record.outputTps !== undefined || !countsTowardAverages(record)) return { record };
	for (let i = records.length - 2; i >= 0; i--) {
		const earlier = records[i];
		if (earlier && countsTowardAverages(earlier) && earlier.outputTps !== undefined) {
			return { record, fallbackTps: earlier.outputTps };
		}
	}
	return { record };
}
