import { classifyBurst } from "./burst.ts";
import type { CalibrationSample } from "./calibration.ts";
import type { Clock } from "./clock.ts";
import {
	CLOCK_SKEW_THRESHOLD_MS,
	LIVE_WARMUP_MS,
	LIVE_WINDOW_MS,
	MIN_SETTLED_SPAN_MS,
	STALL_GAP_MS,
} from "./constants.ts";
import { createDeltaEstimator, type DeltaEstimator, type StreamKind } from "./estimator.ts";
import type { LiveSnapshot, RequestRecord } from "./telemetry.ts";

/** The model serving a request and its calibration ratio (absent when the model is not calibrated yet). */
export interface RequestIdentity {
	provider: string;
	model: string;
	ratio?: number | undefined;
}

/** What is known when a request is sent. */
export interface RequestContext extends RequestIdentity {
	/** Wall-clock milliseconds, stored in the record for display and persistence. */
	wallTime: number;
}

/** The subset of Pi's `AssistantMessage` that settlement reads. */
export interface EndInput {
	stopReason: string;
	provider: string;
	model: string;
	responseModel?: string | undefined;
	durationMs?: number | undefined;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning?: number | undefined;
		cost: { total: number };
	};
}

export type EndOutcome =
	| { kind: "ignored" }
	| { kind: "errored" }
	| { kind: "recorded"; record: RequestRecord; calibration?: CalibrationSample };

/** The content-carrying events of Pi's `AssistantMessageEvent`. */
export interface ContentEvent {
	type: string;
	delta?: string;
}

/** Maps an assistant message event to the stream it extends, or `undefined` when it carries no content. */
export function contentDelta(event: ContentEvent): { stream: StreamKind; text: string } | undefined {
	if (event.delta === undefined || event.delta.length === 0) return undefined;
	switch (event.type) {
		case "thinking_delta":
			return { stream: "thinking", text: event.delta };
		case "text_delta":
			return { stream: "text", text: event.delta };
		case "toolcall_delta":
			return { stream: "toolcall", text: event.delta };
		default:
			return undefined;
	}
}

type Kind = "thinking" | "output";

interface Request {
	context: RequestContext;
	startAt: number;
	headersAt?: number;
	messageStarted: boolean;
	estimator: DeltaEstimator;
	/** Every content delta: arrival time and arriving tokens (the positive part of the estimate increment). */
	at: number[];
	tokens: number[];
	lastKind?: Kind;
	firstAt?: number;
	firstOutputAt?: number;
	/** Output deltas only, with running totals of arriving tokens, for the live window. */
	outputAt: number[];
	outputCumulative: number[];
	arrivedOutput: number;
	/** Net estimates, corrections included. */
	rawOutput: number;
	rawThinking: number;
	thinkingDeltas: number;
	outputSpanMs: number;
	thinkingSpanMs: number;
	stallCount: number;
	stallMs: number;
	inStall: boolean;
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function positive(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

/** Usage counts from providers are trusted only as non-negative finite numbers. */
function count(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** First index whose value is at least `target` in an ascending array. */
function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] ?? 0) < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * State machine measuring the assistant requests of agent turns. Event handlers feed it normalised inputs;
 * it never renders. Time comes from the injected clock.
 */
export class Measurement {
	private turnActive = false;
	/** Set once the turn's assistant message ended; later requests in the turn are nested calls of tools. */
	private turnClosed = false;
	private request: Request | undefined;

	constructor(
		private readonly clock: Clock,
		private readonly createEstimator: () => DeltaEstimator = createDeltaEstimator,
	) {}

	get active(): boolean {
		return this.request !== undefined;
	}

	turnStart(): void {
		this.turnActive = true;
		this.turnClosed = false;
		this.request = undefined;
	}

	/** Returns true when a request without `message_end` was dropped. */
	turnEnd(): boolean {
		this.turnActive = false;
		return this.drop();
	}

	/** Agent end or session shutdown: forget everything in flight. Returns true when a request was dropped. */
	reset(): boolean {
		this.turnActive = false;
		this.turnClosed = false;
		return this.drop();
	}

	private drop(): boolean {
		const dropped = this.request !== undefined;
		this.request = undefined;
		return dropped;
	}

	/**
	 * A provider request is about to be sent. Starts a measurement when it belongs to the active turn. A repeated
	 * request before the stream started is a retry and restarts the measurement; one after it started is a
	 * concurrent call of something else and is ignored.
	 */
	requestStart(context: RequestContext): boolean {
		if (!this.turnActive || this.turnClosed) return false;
		if (this.request?.messageStarted) return false;
		this.request = {
			context,
			startAt: this.clock.now(),
			messageStarted: false,
			estimator: this.createEstimator(),
			at: [],
			tokens: [],
			outputAt: [],
			outputCumulative: [],
			arrivedOutput: 0,
			rawOutput: 0,
			rawThinking: 0,
			thinkingDeltas: 0,
			outputSpanMs: 0,
			thinkingSpanMs: 0,
			stallCount: 0,
			stallMs: 0,
			inStall: false,
		};
		return true;
	}

	responseHeaders(): void {
		if (this.request && this.request.headersAt === undefined) this.request.headersAt = this.clock.now();
	}

	/**
	 * The assistant stream started. `identity` names the model that actually serves the request, which differs from
	 * the selected model when that is a virtual model; it replaces the identity without moving the timing origin.
	 */
	messageStart(identity?: RequestIdentity): void {
		const request = this.request;
		if (!request) return;
		request.messageStarted = true;
		if (identity) request.context = { ...identity, wallTime: request.context.wallTime };
	}

	delta(stream: StreamKind, text: string): void {
		const request = this.request;
		if (!request || text.length === 0) return;
		const now = this.clock.now();
		const kind: Kind = stream === "thinking" ? "thinking" : "output";
		// A negative increment corrects the estimate of text already received; it changes the totals, but no tokens
		// arrived with it, so the live window and the burst features only see the positive part.
		const increment = request.estimator.add(stream, text);
		const arrived = Math.max(0, increment);
		const previousAt = request.at.at(-1);
		if (previousAt !== undefined) {
			const gap = now - previousAt;
			if (gap >= STALL_GAP_MS) {
				request.stallMs += gap;
				if (!request.inStall) request.stallCount++;
				request.inStall = true;
			} else {
				request.inStall = false;
				// A gap between two kinds (thinking to output) belongs to neither span.
				if (request.lastKind === kind) {
					if (kind === "thinking") request.thinkingSpanMs += gap;
					else request.outputSpanMs += gap;
				}
			}
		}
		request.at.push(now);
		request.tokens.push(arrived);
		request.lastKind = kind;
		request.firstAt ??= now;
		if (kind === "thinking") {
			request.rawThinking += increment;
			request.thinkingDeltas++;
		} else {
			request.firstOutputAt ??= now;
			request.rawOutput += increment;
			request.arrivedOutput += arrived;
			request.outputAt.push(now);
			request.outputCumulative.push(request.arrivedOutput);
		}
	}

	/** Live figures of the request in flight, computed at the current time; `requestNumber` is its place in the run. */
	snapshot(requestNumber = 1): LiveSnapshot | undefined {
		const request = this.request;
		if (!request) return undefined;
		const now = this.clock.now();
		const factor = request.context.ratio ?? 1;
		const snapshot: LiveSnapshot = {
			phase: request.firstAt === undefined ? "waiting" : "streaming",
			provider: request.context.provider,
			model: request.context.model,
			request: requestNumber,
			elapsedMs: now - request.startAt,
			outputTokens: request.rawOutput * factor,
			calibrated: request.context.ratio !== undefined,
		};
		if (request.firstAt !== undefined) snapshot.ttftMs = request.firstAt - request.startAt;
		if (request.thinkingDeltas > 0) {
			snapshot.thinkingTokens = request.rawThinking * factor;
			snapshot.thinkingMs = request.thinkingSpanMs;
		}
		const liveTps = this.liveTps(request, now);
		if (liveTps !== undefined) snapshot.liveTps = liveTps * factor;
		return snapshot;
	}

	private liveTps(request: Request, now: number): number | undefined {
		if (request.firstOutputAt === undefined) return undefined;
		const sinceFirst = now - request.firstOutputAt;
		if (sinceFirst < LIVE_WARMUP_MS) return undefined;
		const windowMs = Math.min(LIVE_WINDOW_MS, sinceFirst);
		const start = lowerBound(request.outputAt, now - LIVE_WINDOW_MS);
		const before = start > 0 ? (request.outputCumulative[start - 1] ?? 0) : 0;
		const inWindow = request.arrivedOutput - before;
		return inWindow / (windowMs / 1000);
	}

	/** The turn's assistant message ended. Produces a record for settled and aborted requests. */
	end(message: EndInput): EndOutcome {
		const request = this.request;
		if (!request) return { kind: "ignored" };
		this.request = undefined;
		this.turnClosed = true;
		switch (message.stopReason) {
			case "stop":
			case "length":
			case "toolUse":
				return settle(request, message, this.clock.now(), "settled");
			case "aborted":
				return settle(request, message, this.clock.now(), "aborted");
			default:
				return { kind: "errored" };
		}
	}
}

function settle(request: Request, message: EndInput, now: number, outcome: "settled" | "aborted"): EndOutcome {
	const { usage } = message;
	const factor = request.context.ratio ?? 1;
	const elapsedMs = now - request.startAt;
	const reportedOutput = positive(usage.output) ? usage.output : undefined;
	const rawTotal = request.rawThinking + request.rawOutput;
	const outputTokens = reportedOutput ?? Math.round(rawTotal * factor);
	// Reasoning is a subset of the output; a larger figure is a provider error.
	const reasoning = usage.reasoning === undefined ? undefined : Math.min(count(usage.reasoning), outputTokens);
	const thinkingObserved = request.thinkingDeltas > 0;

	let thinkingTokens: number | undefined;
	let thinkingEstimated = false;
	if (reasoning !== undefined) {
		thinkingTokens = reasoning > 0 ? reasoning : undefined;
	} else if (thinkingObserved) {
		thinkingTokens = Math.min(Math.round(request.rawThinking * factor), outputTokens);
		thinkingEstimated = true;
	}

	const visibleOutput = Math.max(0, outputTokens - (thinkingTokens ?? 0));
	let outputTps =
		request.outputSpanMs >= MIN_SETTLED_SPAN_MS ? visibleOutput / (request.outputSpanMs / 1000) : undefined;
	let thinkingTps =
		thinkingTokens !== undefined && thinkingObserved && request.thinkingSpanMs >= MIN_SETTLED_SPAN_MS
			? thinkingTokens / (request.thinkingSpanMs / 1000)
			: undefined;

	const peakTps = Math.max(outputTps ?? 0, thinkingTps ?? 0);
	const burstReason =
		outcome === "settled"
			? classifyBurst({ at: request.at, tokens: request.tokens }, outputTokens, peakTps > 0 ? peakTps : undefined)
			: undefined;
	let throughputTps: number | undefined;
	if (burstReason !== undefined) {
		outputTps = undefined;
		thinkingTps = undefined;
		throughputTps = elapsedMs > 0 ? outputTokens / (elapsedMs / 1000) : undefined;
	}

	const record: RequestRecord = {
		timestamp: request.context.wallTime,
		provider: message.provider,
		model: message.model,
		outcome,
		burst: burstReason !== undefined,
		elapsedMs: round(elapsedMs, 0),
		// Rounded down so that a span below the 1 s threshold stays below it after persistence.
		outputMs: Math.floor(request.outputSpanMs),
		thinkingObserved,
		estimated: reportedOutput === undefined || thinkingEstimated,
		inputTokens: count(usage.input),
		outputTokens,
		cacheReadTokens: count(usage.cacheRead),
		cacheWriteTokens: count(usage.cacheWrite),
		deltaCount: request.at.length,
		stallCount: request.stallCount,
		stallMs: round(request.stallMs, 0),
	};
	if (message.responseModel !== undefined && message.responseModel !== message.model) {
		record.responseModel = message.responseModel;
	}
	if (burstReason !== undefined) record.burstReason = burstReason;
	if (request.firstAt !== undefined) record.ttftMs = round(request.firstAt - request.startAt, 0);
	if (request.firstOutputAt !== undefined) record.ttftTextMs = round(request.firstOutputAt - request.startAt, 0);
	if (request.headersAt !== undefined) record.headersMs = round(request.headersAt - request.startAt, 0);
	if (outputTps !== undefined) record.outputTps = round(outputTps, 2);
	if (thinkingTps !== undefined) record.thinkingTps = round(thinkingTps, 2);
	if (throughputTps !== undefined) record.throughputTps = round(throughputTps, 2);
	if (thinkingObserved) record.thinkingMs = Math.floor(request.thinkingSpanMs);
	if (thinkingTokens !== undefined) record.thinkingTokens = thinkingTokens;
	if (reasoning !== undefined) record.reasoningTokens = reasoning;
	if (positive(usage.cost.total)) record.cost = usage.cost.total;
	if (message.durationMs !== undefined) {
		const skew = message.durationMs - elapsedMs;
		if (Math.abs(skew) > CLOCK_SKEW_THRESHOLD_MS) record.clockSkewMs = round(skew, 0);
	}

	if (outcome !== "settled" || burstReason !== undefined || reportedOutput === undefined) {
		return { kind: "recorded", record };
	}
	// With a reasoning breakdown, compare visible output only: streamed thinking is often a summary or hidden,
	// so its raw estimate does not correspond to the reasoning tokens in usage.output.
	const calibration: CalibrationSample =
		reasoning !== undefined
			? { reported: reportedOutput - reasoning, estimated: request.rawOutput }
			: { reported: reportedOutput, estimated: rawTotal };
	return { kind: "recorded", record, calibration };
}
