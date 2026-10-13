import {
	BURST_BATCH_GAP_MS,
	BURST_CLUSTER_MIN_SPAN_MS,
	BURST_CLUSTER_SHARE,
	BURST_CLUSTER_WINDOW_MS,
	BURST_MIN_BATCHES,
	BURST_MIN_TOKENS,
	MAX_PLAUSIBLE_TPS,
} from "./constants.ts";
import type { BurstReason } from "./telemetry.ts";

/** Arrival times (ascending) and estimated tokens of every content delta of one request. */
export interface DeltaTimeline {
	readonly at: readonly number[];
	readonly tokens: readonly number[];
}

/**
 * Number of arrival batches. Pi parses every stream event of one network read in the same tick, so deltas less
 * than {@link BURST_BATCH_GAP_MS} apart are one delivery, however many events they are.
 */
export function countBatches(at: readonly number[]): number {
	let batches = 0;
	let previous: number | undefined;
	for (const time of at) {
		if (previous === undefined || time - previous >= BURST_BATCH_GAP_MS) batches++;
		previous = time;
	}
	return batches;
}

/** Largest share of all tokens that arrived within one cluster window. */
export function largestClusterShare(timeline: DeltaTimeline): number {
	const { at, tokens } = timeline;
	const total = tokens.reduce((sum, value) => sum + value, 0);
	if (total <= 0) return 0;
	let best = 0;
	let windowTokens = 0;
	let start = 0;
	for (let end = 0; end < at.length; end++) {
		windowTokens += tokens[end] ?? 0;
		const endAt = at[end] ?? 0;
		while ((at[start] ?? endAt) < endAt - BURST_CLUSTER_WINDOW_MS) {
			windowTokens -= tokens[start] ?? 0;
			start++;
		}
		best = Math.max(best, windowTokens);
	}
	return best / total;
}

/**
 * Classifies a request as burst delivery (a buffered response flushed at once) rather than streaming.
 * `outputTokens` is the response's output token count; `peakTps` the highest rate computed for it, if any.
 * A response under {@link BURST_MIN_TOKENS} in few batches is merely short, not buffered.
 */
export function classifyBurst(
	timeline: DeltaTimeline,
	outputTokens: number,
	peakTps?: number,
): BurstReason | undefined {
	const { at } = timeline;
	if (countBatches(at) < BURST_MIN_BATCHES && outputTokens >= BURST_MIN_TOKENS) return "few-batches";
	// The span is first to last delta, stalls included: a flush after a long silence is exactly what this catches.
	const span = (at.at(-1) ?? 0) - (at[0] ?? 0);
	if (span > BURST_CLUSTER_MIN_SPAN_MS && largestClusterShare(timeline) >= BURST_CLUSTER_SHARE) return "cluster";
	if (peakTps !== undefined && peakTps > MAX_PLAUSIBLE_TPS) return "rate";
	return undefined;
}
