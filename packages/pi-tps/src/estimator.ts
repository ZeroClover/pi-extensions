import { estimateTokenCount } from "tokenx";
import { ESTIMATOR_COMMIT_CHARS, ESTIMATOR_MAX_OPEN_CHARS } from "./constants.ts";

// The characters at which tokenx splits text into segments: whitespace and these ASCII punctuation marks.
const SEPARATOR = /[\s.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_"-]/;

/** Index where the text's last segment starts: a run of word characters, or of separators. */
function lastSegmentStart(text: string): number {
	const lastIsSeparator = SEPARATOR.test(text.charAt(text.length - 1));
	for (let i = text.length - 1; i > 0; i--) {
		if (SEPARATOR.test(text.charAt(i - 1)) !== lastIsSeparator) return i;
	}
	return 0;
}

/** Chunk length that does not split a surrogate pair. */
function chunkEnd(text: string, length: number): number {
	const code = text.charCodeAt(length);
	return code >= 0xdc00 && code <= 0xdfff ? length - 1 : length;
}

/**
 * Estimates one stream of deltas incrementally. Only the last segment stays open; everything before it can no
 * longer change and is committed once. After each delta the total is the committed estimate plus the estimate of
 * the open segment, so it equals the estimate of the whole text received so far, whatever the delta sizes. An
 * increment can be negative, because tokenx's estimate of a segment is not monotonic in its length (a digit run
 * followed by `n` is a word, not a number). An open segment longer than {@link ESTIMATOR_MAX_OPEN_CHARS} is committed
 * in pieces of {@link ESTIMATOR_COMMIT_CHARS}, each estimated on its own, which bounds the work per delta.
 */
export class StreamEstimator {
	private open = "";
	private committed = 0;
	private total = 0;

	add(delta: string): number {
		if (delta.length === 0) return 0;
		const text = this.open + delta;
		const start = lastSegmentStart(text);
		if (start > 0) this.committed += estimateTokenCount(text.slice(0, start));
		let open = text.slice(start);
		while (open.length > ESTIMATOR_MAX_OPEN_CHARS) {
			const end = chunkEnd(open, ESTIMATOR_COMMIT_CHARS);
			this.committed += estimateTokenCount(open.slice(0, end));
			open = open.slice(end);
		}
		this.open = open;
		const total = this.committed + estimateTokenCount(open);
		const increment = total - this.total;
		this.total = total;
		return increment;
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
