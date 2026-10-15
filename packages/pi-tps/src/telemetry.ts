import { finite, isRecord } from "./guards.ts";

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

export const TELEMETRY_VERSION = 2;

export type BurstReason = "few-batches" | "cluster" | "rate";

/**
 * How a request's thinking showed in the stream: `none` without a thinking phase, `hidden` when its phases streamed
 * no thinking delta (hidden or encrypted reasoning), `streamed` when thinking deltas arrived.
 */
export type ThinkingKind = "none" | "hidden" | "streamed";

/** A provider and one of its models. */
export interface ModelRef {
	provider: string;
	model: string;
}

/** One measured request. Durations are milliseconds on a monotonic clock, rates are tokens per second. */
export interface RequestRecord {
	/** Wall-clock milliseconds when the request was sent. */
	timestamp: number;
	/** The serving provider and model, named by the assistant message. */
	provider: string;
	model: string;
	responseModel?: string;
	/** The model selected when the request was sent, only when it differs from the serving model (a virtual model). */
	requested?: ModelRef;
	outcome: "settled" | "aborted";
	burst: boolean;
	burstReason?: BurstReason;
	/**
	 * Request start to the first non-empty delta of any kind, or to the `thinking_start` of the block that delta
	 * belongs to when it is a thinking delta.
	 */
	ttftMs?: number;
	/** Request start to the first non-empty text or tool-call delta. */
	ttftTextMs?: number;
	/** Request start to the provider's response headers. */
	headersMs?: number;
	/** Request start to `message_end`. */
	elapsedMs: number;
	/** Active output span: gaps between consecutive output deltas, stalls excluded. */
	outputMs: number;
	/**
	 * Generation time, unrounded because it is the denominator of `tps`: the thinking time plus the active output span
	 * when a thinking phase was observed, else the counted output time (the output span without the backlog windows
	 * after the first delta and after stalls); 0 when no output estimate arrived.
	 */
	generationMs: number;
	/**
	 * Tokens the generation rate counts: all output tokens (thinking included) when a thinking phase was observed,
	 * else the output tokens without the reported reasoning tokens, scaled by the share of the arriving output
	 * estimate that was counted (possibly fractional; 0 when no output estimate arrived).
	 */
	generatedTokens: number;
	/**
	 * Generation rate: generated tokens over the generation time, unrounded. Absent for bursts and generation times
	 * under 1 s.
	 */
	tps?: number;
	/** Visible output tokens over the active output span. Absent for bursts and spans under 1 s. */
	outputTps?: number;
	/** Thinking tokens over the thinking time. */
	thinkingTps?: number;
	/** Burst requests only: output tokens over the elapsed time. */
	throughputTps?: number;
	/** Thinking time: summed wall time of the thinking phases. Absent without a thinking phase. */
	thinkingMs?: number;
	/** `usage.reasoning` when positive, else the calibrated estimate of streamed thinking. */
	thinkingTokens?: number;
	thinking: ThinkingKind;
	/**
	 * True when the provider reported no output usage, so the token counts and rates rest on the calibrated estimate.
	 * Thinking tokens of streamed thinking without a positive reasoning count are estimated as well.
	 */
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

/** Smoothed averages of one model; each is absent until the model has a positive sample of it. */
export interface Averages {
	/** Generation rate of streamed requests, tokens per second. */
	tps?: number;
	/** Throughput of burst requests, tokens per second. */
	burstTps?: number;
	ttftMs?: number;
}

/** Figures of the request in flight. */
export interface LiveSnapshot {
	phase: "waiting" | "streaming";
	/** The model serving the request: the selected model until `message_start` names the serving one. */
	provider: string;
	model: string;
	/** Number of the request within its run, starting at 1. */
	request: number;
	elapsedMs: number;
	/** Request start to the first content; absent until a non-empty delta arrived. */
	ttftMs?: number;
	/** Calibrated generation rate (thinking and output) over the live window; absent until it holds 1.5 s. */
	liveTps?: number;
	/** Calibrated estimate of visible output tokens so far. */
	outputTokens: number;
	/** Calibrated estimate of streamed thinking tokens; absent unless thinking was streamed. */
	thinkingTokens?: number;
	/** Thinking time so far, the open phase included; absent without a thinking phase. */
	thinkingMs?: number;
	thinking: ThinkingKind;
	/** Averages of the serving model, without the request in flight. */
	average: Averages;
}

/** A run is active between requests, typically while tools execute. */
export interface WorkingSnapshot {
	phase: "working";
	elapsedMs: number;
	requests: number;
	/** Visible output tokens of the run's requests so far. */
	outputTokens: number;
	/** Averages of the current model. */
	average: Averages;
}

/** Sums over every run on the branch, aborted runs included. */
export interface SessionTotals {
	runs: number;
	/** Summed wall time of the runs. */
	elapsedMs: number;
	requests: number;
	/** Input tokens without cache reads and writes, as in the request records. */
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Output tokens without thinking. */
	visibleOutputTokens: number;
	thinkingTokens: number;
	/** USD over the requests that carry a cost; absent when none does. */
	cost?: number;
	/** Whether the last run was aborted. */
	lastAborted: boolean;
}

/** No run is active. */
export interface IdleSnapshot {
	phase: "idle";
	/** Averages of the current model. */
	average: Averages;
	/** Absent while the branch holds no run. */
	session?: SessionTotals;
}

export type StatusSnapshot = LiveSnapshot | WorkingSnapshot | IdleSnapshot;

const BURST_REASONS: readonly BurstReason[] = ["few-batches", "cluster", "rate"];

function isBurstReason(value: unknown): value is BurstReason {
	return BURST_REASONS.some((reason) => reason === value);
}

const THINKING_KINDS: readonly ThinkingKind[] = ["none", "hidden", "streamed"];

function isThinkingKind(value: unknown): value is ThinkingKind {
	return THINKING_KINDS.some((kind) => kind === value);
}

/** Counts, durations and rates in a record are never negative. */
function nonNegative(value: unknown): value is number {
	return finite(value) && value >= 0;
}

function parseModelRef(value: unknown): ModelRef | undefined {
	if (!isRecord(value)) return undefined;
	const { provider, model } = value;
	return typeof provider === "string" && typeof model === "string" ? { provider, model } : undefined;
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
		generationMs,
		generatedTokens,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		deltaCount,
		stallCount,
		stallMs,
		burst,
		thinking,
		estimated,
		responseModel,
		requested,
		burstReason,
	} = data;
	if (outcome !== "settled" && outcome !== "aborted") return undefined;
	if (typeof provider !== "string" || typeof model !== "string") return undefined;
	if (
		!nonNegative(timestamp) ||
		!nonNegative(elapsedMs) ||
		!nonNegative(outputMs) ||
		!nonNegative(generationMs) ||
		!nonNegative(generatedTokens) ||
		!nonNegative(inputTokens) ||
		!nonNegative(outputTokens) ||
		!nonNegative(cacheReadTokens) ||
		!nonNegative(cacheWriteTokens) ||
		!nonNegative(deltaCount) ||
		!nonNegative(stallCount) ||
		!nonNegative(stallMs) ||
		typeof burst !== "boolean" ||
		!isThinkingKind(thinking) ||
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
		generationMs,
		generatedTokens,
		thinking,
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
	// Like `responseModel`, a malformed value is dropped; the record then reads as sent under its serving model.
	const requestedModel = parseModelRef(requested);
	if (requestedModel) record.requested = requestedModel;
	if (isBurstReason(burstReason)) record.burstReason = burstReason;
	const optional = [
		"ttftMs",
		"ttftTextMs",
		"headersMs",
		"tps",
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

/** Validates an entry's data as a run record of the current version. Unknown versions and malformed shapes yield `undefined`. */
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
