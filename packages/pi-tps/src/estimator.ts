import { estimateTokenCount } from "tokenx";
import { ESTIMATOR_CONTEXT_CHARS } from "./constants.ts";

/** Heuristic token count of a complete text. */
export function estimateTokens(text: string): number {
	return text.length === 0 ? 0 : estimateTokenCount(text);
}

/**
 * Estimates one stream of deltas incrementally. Each delta is estimated once, together with a short trailing
 * context of the previous text, and counted as the difference. Estimating a bare delta would count a word split
 * across two deltas as two words; the context makes the running total track the estimate of the whole text.
 */
export class StreamEstimator {
	private context = "";

	add(delta: string): number {
		if (delta.length === 0) return 0;
		const joined = this.context + delta;
		const tokens = Math.max(0, estimateTokens(joined) - estimateTokens(this.context));
		this.context = joined.length > ESTIMATOR_CONTEXT_CHARS ? joined.slice(-ESTIMATOR_CONTEXT_CHARS) : joined;
		return tokens;
	}
}

/** Content streams of an assistant message. Each keeps its own estimation context. */
export type StreamKind = "thinking" | "text" | "toolcall";

/** Estimates the deltas of one request. */
export interface DeltaEstimator {
	add(stream: StreamKind, delta: string): number;
}

export function createDeltaEstimator(): DeltaEstimator {
	const streams = new Map<StreamKind, StreamEstimator>();
	return {
		add(stream, delta) {
			let estimator = streams.get(stream);
			if (!estimator) {
				estimator = new StreamEstimator();
				streams.set(stream, estimator);
			}
			return estimator.add(delta);
		},
	};
}
