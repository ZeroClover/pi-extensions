/** `customType` of the session entries holding telemetry records. */
export const TELEMETRY_CUSTOM_TYPE = "pi-tps";

/** Event-bus channel carrying a {@link StatusSnapshot}, or `null` when the readout is cleared. */
export const STATUS_CHANNEL = "pi-tps:status";
/** Event-bus channel carrying each persisted {@link TelemetryRecord}. */
export const TELEMETRY_CHANNEL = "pi-tps:telemetry";
/** Emitting on this channel makes pi-tps re-emit the current snapshot on {@link STATUS_CHANNEL}. */
export const REQUEST_CHANNEL = "pi-tps:request";

export const TELEMETRY_VERSION = 1;

export type BurstReason = "few-batches" | "cluster" | "rate";

export type SummaryMode = "last" | "session";

/** One measured request. Durations are milliseconds on a monotonic clock, rates are tokens per second. */
export interface TelemetryRecord {
	version: typeof TELEMETRY_VERSION;
	/** Wall-clock milliseconds when the request was sent. */
	timestamp: number;
	provider: string;
	model: string;
	responseModel?: string;
	outcome: "settled" | "aborted";
	burst: boolean;
	burstReason?: BurstReason;
	/** Request start to the first non-empty delta of any kind. */
	ttftMs?: number;
	/** Request start to the first non-empty text or tool-call delta. */
	ttftTextMs?: number;
	/** Request start to the provider's response headers. */
	headersMs?: number;
	/** Request start to `message_end`. */
	elapsedMs: number;
	/** Visible output tokens over the active output span. Absent for bursts and spans under 1 s. */
	outputTps?: number;
	/** Thinking tokens over the active thinking span. */
	thinkingTps?: number;
	/** Burst requests only: output tokens over the elapsed time. */
	throughputTps?: number;
	/** Active thinking span. */
	thinkingMs?: number;
	thinkingTokens?: number;
	/** Whether thinking deltas were streamed (false for hidden or encrypted reasoning). */
	thinkingObserved: boolean;
	/** True when a reported figure relies on the token estimate instead of provider usage. */
	estimated: boolean;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens?: number;
	deltaCount: number;
	stallCount: number;
	stallMs: number;
	/** USD, only when the model has a price. */
	cost?: number;
	/** Pi's `durationMs` minus the measured elapsed time, when they differ by more than 250 ms. */
	clockSkewMs?: number;
}

export interface SessionAggregate {
	count: number;
	meanTtftMs?: number;
	/** Over settled, non-burst requests with an output TPS. */
	meanOutputTps?: number;
	meanThinkingTps?: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Over records that carry a cost; absent when none does. */
	cost?: number;
}

/** Figures of the request in flight. */
export interface LiveSnapshot {
	phase: "waiting" | "streaming";
	provider: string;
	model: string;
	elapsedMs: number;
	ttftMs?: number;
	/** Calibrated output tokens per second over the live window; absent during warm-up. */
	liveTps?: number;
	/** Calibrated estimate of output tokens so far. */
	outputTokens: number;
	thinkingTokens?: number;
	thinkingMs?: number;
	/** False when the active model has no calibration ratio yet. */
	calibrated: boolean;
}

export type StatusSnapshot =
	| LiveSnapshot
	| {
			phase: "last";
			record: TelemetryRecord;
			/** Output TPS of the most recent earlier request that had one, shown when `record` has none. */
			fallbackTps?: number;
	  }
	| { phase: "session"; aggregate: SessionAggregate }
	| { phase: "empty"; mode: SummaryMode };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BURST_REASONS: readonly BurstReason[] = ["few-batches", "cluster", "rate"];

function isBurstReason(value: unknown): value is BurstReason {
	return BURST_REASONS.some((reason) => reason === value);
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Validates an entry's data as a version-1 record. Unknown versions and malformed shapes yield `undefined`. */
export function parseRecord(data: unknown): TelemetryRecord | undefined {
	if (!isRecord(data)) return undefined;
	const {
		version,
		outcome,
		provider,
		model,
		timestamp,
		elapsedMs,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		deltaCount,
		stallCount,
		stallMs,
		burst,
		thinkingObserved,
		estimated,
		responseModel,
		burstReason,
	} = data;
	if (version !== TELEMETRY_VERSION) return undefined;
	if (outcome !== "settled" && outcome !== "aborted") return undefined;
	if (typeof provider !== "string" || typeof model !== "string") return undefined;
	if (
		!finite(timestamp) ||
		!finite(elapsedMs) ||
		!finite(inputTokens) ||
		!finite(outputTokens) ||
		!finite(cacheReadTokens) ||
		!finite(cacheWriteTokens) ||
		!finite(deltaCount) ||
		!finite(stallCount) ||
		!finite(stallMs) ||
		typeof burst !== "boolean" ||
		typeof thinkingObserved !== "boolean" ||
		typeof estimated !== "boolean"
	) {
		return undefined;
	}
	const record: TelemetryRecord = {
		version: TELEMETRY_VERSION,
		timestamp,
		provider,
		model,
		outcome,
		burst,
		elapsedMs,
		thinkingObserved,
		estimated,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		deltaCount,
		stallCount,
		stallMs,
	};
	if (typeof responseModel === "string") record.responseModel = responseModel;
	if (isBurstReason(burstReason)) record.burstReason = burstReason;
	const optional = [
		"ttftMs",
		"ttftTextMs",
		"headersMs",
		"outputTps",
		"thinkingTps",
		"throughputTps",
		"thinkingMs",
		"thinkingTokens",
		"reasoningTokens",
		"cost",
		"clockSkewMs",
	] as const;
	for (const key of optional) {
		const value = data[key];
		if (value === undefined) continue;
		if (!finite(value)) return undefined;
		record[key] = value;
	}
	return record;
}
