import { estimateTokenCount } from "tokenx";
import { ESTIMATOR_COMMIT_CHARS, ESTIMATOR_MAX_OPEN_CHARS } from "./constants.ts";

/** Heuristic token count of a complete text. */
export function estimateTokens(text: string): number {
	return text.length === 0 ? 0 : estimateTokenCount(text);
}

// The characters at which tokenx splits text into segments: whitespace and these ASCII punctuation marks.
const SEPARATOR = /[\s.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_"-]/;

/** Index where the last word starts after a separator, or 0 when the text has no such boundary. */
function lastSegmentStart(text: string): number {
	for (let i = text.length - 1; i > 0; i--) {
		if (SEPARATOR.test(text.charAt(i - 1)) && !SEPARATOR.test(text.charAt(i))) return i;
	}
	return 0;
}

/** Chunk length that does not split a surrogate pair. */
function chunkEnd(text: string, length: number): number {
	const code = text.charCodeAt(length);
	return code >= 0xdc00 && code <= 0xdfff ? length - 1 : length;
}

/**
 * Estimates one stream of deltas incrementally, so that the running total tracks the estimate of the whole text
 * whatever the delta sizes. Segments that can no longer grow are committed once; only the open trailing segment is
 * re-estimated per delta. An over-long open segment (digit runs, CJK prose without ASCII separators) is committed in
 * chunks so each delta costs bounded work.
 */
export class StreamEstimator {
	private open = "";
	private committed = 0;
	/** Tokens already returned; the total can dip when a segment changes class, so returns never go below it. */
	private returned = 0;

	add(delta: string): number {
		if (delta.length === 0) return 0;
		const text = this.open + delta;
		const start = lastSegmentStart(text);
		if (start > 0) this.committed += estimateTokens(text.slice(0, start));
		let open = text.slice(start);
		while (open.length > ESTIMATOR_MAX_OPEN_CHARS) {
			const end = chunkEnd(open, ESTIMATOR_COMMIT_CHARS);
			this.committed += estimateTokens(open.slice(0, end));
			open = open.slice(end);
		}
		this.open = open;
		const total = this.committed + estimateTokens(open);
		const added = Math.max(0, total - this.returned);
		this.returned += added;
		return added;
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
