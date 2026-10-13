/** `customType` of the session entries holding run records. */
export const TELEMETRY_CUSTOM_TYPE = "pi-tps";

/** Event-bus channel carrying a {@link StatusSnapshot}, or `null` when the session shuts down. */
export const STATUS_CHANNEL = "pi-tps:status";
/** Event-bus channel carrying each {@link RequestRecord} as its request settles or aborts. */
export const TELEMETRY_CHANNEL = "pi-tps:telemetry";
/** Event-bus channel carrying each {@link RunRecord} when its run settles; equal to the persisted entry data. */
export const RUN_CHANNEL = "pi-tps:run";
/** Emitting on this channel makes pi-tps re-emit the current snapshot on {@link STATUS_CHANNEL}. */
export const REQUEST_CHANNEL = "pi-tps:request";

export const TELEMETRY_VERSION = 1;

export type BurstReason = "few-batches" | "cluster" | "rate";

export type SummaryMode = "last" | "session";

/** One measured request. Durations are milliseconds on a monotonic clock, rates are tokens per second. */
export interface RequestRecord {
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
	/** Active output span: gaps between consecutive output deltas, stalls excluded. */
	outputMs: number;
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
	/** Total output tokens including thinking (`usage.output`, or the calibrated estimate without usage). */
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

/** One agent run: everything between `agent_start` and `agent_settled`. */
export interface RunRecord {
	version: typeof TELEMETRY_VERSION;
	/** Wall-clock milliseconds when the run started. */
	startedAt: number;
	/** Run wall time on the monotonic clock. */
	elapsedMs: number;
	aborted: boolean;
	requests: RequestRecord[];
}

/** Figures aggregated over request records; the same method serves runs and sessions. */
export interface Aggregate {
	requests: number;
	/** Visible output tokens over active output spans of settled, non-burst requests. */
	tps?: number;
	/** Whether a request contributing to the TPS relied on the estimate. */
	estimated: boolean;
	/** Output tokens over elapsed time of burst requests, only when no request contributes to the TPS. */
	burstTps?: number;
	/** Mean over non-aborted requests. */
	ttftMs?: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Output tokens without thinking. */
	visibleOutputTokens: number;
	thinkingTokens: number;
	thinkingMs: number;
	stallMs: number;
	stallCount: number;
	cost?: number;
	/** Model of the last request contributing to the TPS (else the last request), for the colour thresholds. */
	provider?: string;
	model?: string;
}

export interface RunSummary extends Aggregate {
	elapsedMs: number;
	aborted: boolean;
}

export interface SessionSummary extends Aggregate {
	runs: number;
}

/** Figures of the request in flight. */
export interface LiveSnapshot {
	phase: "waiting" | "streaming";
	provider: string;
	model: string;
	/** Number of the request within its run, starting at 1. */
	request: number;
	elapsedMs: number;
	ttftMs?: number;
	/** Calibrated output tokens per second over the live window; absent during warm-up. */
	liveTps?: number;
	/** Calibrated estimate of visible output tokens so far. */
	outputTokens: number;
	thinkingTokens?: number;
	thinkingMs?: number;
	/** False when the serving model has no calibration ratio yet. */
	calibrated: boolean;
}

/** A run is active between requests, typically while tools execute. */
export interface WorkingSnapshot {
	phase: "working";
	elapsedMs: number;
	requests: number;
	/** Visible output tokens of the run's requests so far. */
	outputTokens: number;
}

export type StatusSnapshot =
	| LiveSnapshot
	| WorkingSnapshot
	| { phase: "run"; run: RunSummary }
	| { phase: "session"; session: SessionSummary }
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

/** Counts, durations and rates in a record are never negative. */
function nonNegative(value: unknown): value is number {
	return finite(value) && value >= 0;
}

/** Validates one request record. Malformed shapes yield `undefined`. */
export function parseRequestRecord(data: unknown): RequestRecord | undefined {
	if (!isRecord(data)) return undefined;
	const {
		outcome,
		provider,
		model,
		timestamp,
		elapsedMs,
		outputMs,
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
	if (outcome !== "settled" && outcome !== "aborted") return undefined;
	if (typeof provider !== "string" || typeof model !== "string") return undefined;
	if (
		!nonNegative(timestamp) ||
		!nonNegative(elapsedMs) ||
		!nonNegative(outputMs) ||
		!nonNegative(inputTokens) ||
		!nonNegative(outputTokens) ||
		!nonNegative(cacheReadTokens) ||
		!nonNegative(cacheWriteTokens) ||
		!nonNegative(deltaCount) ||
		!nonNegative(stallCount) ||
		!nonNegative(stallMs) ||
		typeof burst !== "boolean" ||
		typeof thinkingObserved !== "boolean" ||
		typeof estimated !== "boolean"
	) {
		return undefined;
	}
	const record: RequestRecord = {
		timestamp,
		provider,
		model,
		outcome,
		burst,
		elapsedMs,
		outputMs,
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
		// The clock skew is signed; every other optional figure is a count, a duration or a rate.
		if (!finite(value) || (key !== "clockSkewMs" && value < 0)) return undefined;
		record[key] = value;
	}
	return record;
}

/** Validates an entry's data as a version-1 run record. Unknown versions and malformed shapes yield `undefined`. */
export function parseRunRecord(data: unknown): RunRecord | undefined {
	if (!isRecord(data)) return undefined;
	const { version, startedAt, elapsedMs, aborted, requests } = data;
	if (version !== TELEMETRY_VERSION) return undefined;
	if (!nonNegative(startedAt) || !nonNegative(elapsedMs) || typeof aborted !== "boolean") return undefined;
	if (!Array.isArray(requests) || requests.length === 0) return undefined;
	const parsed: RequestRecord[] = [];
	for (const request of requests) {
		const record = parseRequestRecord(request);
		if (!record) return undefined;
		parsed.push(record);
	}
	return { version: TELEMETRY_VERSION, startedAt, elapsedMs, aborted, requests: parsed };
}
