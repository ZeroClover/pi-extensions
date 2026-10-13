import { classifyBurst } from "./burst.ts";
import type { CalibrationRatios, CalibrationSample } from "./calibration.ts";
import type { Clock } from "./clock.ts";
import {
	BURST_BATCH_GAP_MS,
	CLOCK_SKEW_THRESHOLD_MS,
	LIVE_MIN_COUNTED_MS,
	LIVE_WINDOW_MS,
	MIN_SETTLED_SPAN_MS,
	STALL_GAP_MS,
} from "./constants.ts";
import { createDeltaEstimator, type DeltaEstimator, type StreamKind } from "./estimator.ts";
import type { LiveSnapshot, RequestRecord, ThinkingKind } from "./telemetry.ts";

/** The model serving a request and its calibration ratios (a kind is absent while it is not calibrated). */
export interface RequestIdentity {
	provider: string;
	model: string;
	ratios: CalibrationRatios;
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

/** Calibration samples a settled request yields, per token kind. */
export interface CalibrationSamples {
	output?: CalibrationSample;
	thinking?: CalibrationSample;
}

export type EndOutcome =
	| { kind: "ignored" }
	| { kind: "errored" }
	| { kind: "recorded"; record: RequestRecord; calibration: CalibrationSamples };

/** The fields of Pi's `AssistantMessageEvent` that phase tracking reads. */
export interface AssistantEventLike {
	type: string;
	delta?: string;
}

/** Normalised stream events: the boundaries of thinking blocks, the start of an output block, and content. */
export type PhaseEvent =
	| { type: "thinking_start" }
	| { type: "thinking_end" }
	| { type: "output_start" }
	| { type: "delta"; stream: StreamKind; text: string };

function contentEvent(stream: StreamKind, text: string | undefined): PhaseEvent | undefined {
	return text === undefined || text.length === 0 ? undefined : { type: "delta", stream, text };
}

/**
 * Maps an assistant message event to the phase event it carries, or `undefined` for events that neither bound a
 * thinking block nor carry content (`start`, `text_end`, `toolcall_end`, `done`, `error`, empty deltas).
 */
export function phaseEvent(event: AssistantEventLike): PhaseEvent | undefined {
	switch (event.type) {
		case "thinking_start":
			return { type: "thinking_start" };
		case "thinking_end":
			return { type: "thinking_end" };
		case "text_start":
		case "toolcall_start":
			return { type: "output_start" };
		case "thinking_delta":
			return contentEvent("thinking", event.delta);
		case "text_delta":
			return contentEvent("text", event.delta);
		case "toolcall_delta":
			return contentEvent("toolcall", event.delta);
		default:
			return undefined;
	}
}

export type Kind = "thinking" | "output";

/**
 * Arrivals of one request for the live window: arrival time, arriving raw tokens, kind, and whether the arrival is
 * attributed to the interval since the previous arrival (false for the first arrival of a phase and output stalls).
 */
export interface LiveTimeline {
	readonly at: readonly number[];
	readonly tokens: readonly number[];
	readonly kinds: readonly Kind[];
	readonly counted: readonly boolean[];
}

/** Calibrated tokens and counted time inside a window, and the kinds whose tokens contribute. */
export interface WindowFigures {
	tokens: number;
	ms: number;
	kinds: Set<Kind>;
}

/**
 * Sums the counted intervals of a timeline that lie inside `(windowStart, now]`. An interval straddling the window
 * edge contributes the share of its tokens that matches the share of its duration inside the window. Arrivals are
 * scanned from the newest, so the cost is the number of arrivals in the window.
 */
export function windowFigures(
	timeline: LiveTimeline,
	windowStart: number,
	factor: (kind: Kind) => number,
): WindowFigures {
	const figures: WindowFigures = { tokens: 0, ms: 0, kinds: new Set() };
	for (let i = timeline.at.length - 1; i > 0; i--) {
		const to = timeline.at[i] ?? 0;
		if (to <= windowStart) break;
		if (!timeline.counted[i]) continue;
		const from = timeline.at[i - 1] ?? to;
		const kind = timeline.kinds[i] ?? "output";
		const tokens = (timeline.tokens[i] ?? 0) * factor(kind);
		const length = to - from;
		const inside = to - Math.max(from, windowStart);
		figures.tokens += length > 0 ? (tokens * inside) / length : tokens;
		figures.ms += inside;
		if (tokens > 0) figures.kinds.add(kind);
	}
	return figures;
}

interface ThinkingBlock {
	startAt: number;
	/** Opened by `thinking_start` rather than by its first delta. */
	byEvent: boolean;
	streamed: boolean;
}

interface Request {
	context: RequestContext;
	startAt: number;
	headersAt?: number;
	messageStarted: boolean;
	estimator: DeltaEstimator;
	/** Arrivals for the live window; deltas of one network read and phase are merged into one arrival. */
	live: { at: number[]; tokens: number[]; kinds: Kind[]; counted: boolean[] };
	/** Output deltas only, for burst detection: arrival time and arriving tokens. */
	outputAt: number[];
	outputArrived: number[];
	/** Identifies the current phase: changes when a thinking block opens or closes. */
	phase: number;
	/** Phase, time and kind of the last delta. */
	lastPhase?: number;
	lastAt?: number;
	lastKind?: Kind;
	block?: ThinkingBlock | undefined;
	thinking: ThinkingKind;
	/** Summed wall time of the closed thinking blocks. */
	thinkingMs: number;
	firstAt?: number;
	firstOutputAt?: number;
	/** Net estimates, corrections included. */
	rawOutput: number;
	rawThinking: number;
	outputSpanMs: number;
	deltaCount: number;
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

function factors(context: RequestContext): Record<Kind, number> {
	return { output: context.ratios.output ?? 1, thinking: context.ratios.thinking ?? 1 };
}

function closeBlock(request: Request, now: number): void {
	const block = request.block;
	if (!block) return;
	request.thinkingMs += now - block.startAt;
	request.block = undefined;
	request.phase++;
}

function openBlock(request: Request, now: number, byEvent: boolean): ThinkingBlock {
	closeBlock(request, now);
	const block: ThinkingBlock = { startAt: now, byEvent, streamed: false };
	request.block = block;
	request.phase++;
	if (request.thinking === "none") request.thinking = "hidden";
	return block;
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
			live: { at: [], tokens: [], kinds: [], counted: [] },
			outputAt: [],
			outputArrived: [],
			phase: 0,
			thinking: "none",
			thinkingMs: 0,
			rawOutput: 0,
			rawThinking: 0,
			outputSpanMs: 0,
			deltaCount: 0,
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

	event(event: PhaseEvent): void {
		switch (event.type) {
			case "thinking_start":
				this.thinkingStart();
				return;
			case "thinking_end":
			case "output_start":
				this.closeThinking();
				return;
			case "delta":
				this.delta(event.stream, event.text);
				return;
		}
	}

	/** A thinking block opens; an open one closes first. */
	thinkingStart(): void {
		if (this.request) openBlock(this.request, this.clock.now(), true);
	}

	/** A thinking block ends (`thinking_end`) or an output block starts; either closes an open thinking block. */
	closeThinking(): void {
		if (this.request) closeBlock(this.request, this.clock.now());
	}

	delta(stream: StreamKind, text: string): void {
		const request = this.request;
		if (!request || text.length === 0) return;
		const now = this.clock.now();
		const kind: Kind = stream === "thinking" ? "thinking" : "output";
		if (kind === "thinking") {
			const block = request.block ?? openBlock(request, now, false);
			block.streamed = true;
			request.thinking = "streamed";
		} else {
			closeBlock(request, now);
		}
		// TTFT ends at the start of the thinking block whose content arrives first, when the provider signalled it.
		request.firstAt ??= kind === "thinking" && request.block?.byEvent ? request.block.startAt : now;

		// A negative increment corrects the estimate of text already received; it changes the totals, but no tokens
		// arrived with it, so the live window and the burst features only see the positive part.
		const increment = request.estimator.add(stream, text);
		const arrived = Math.max(0, increment);
		request.deltaCount++;

		const samePhase = request.lastPhase === request.phase && request.lastAt !== undefined;
		const gap = request.lastAt === undefined ? 0 : now - request.lastAt;
		let counted = false;
		if (samePhase && kind === "thinking") {
			counted = true;
		} else if (samePhase) {
			if (gap >= STALL_GAP_MS) {
				request.stallMs += gap;
				if (!request.inStall) request.stallCount++;
				request.inStall = true;
			} else {
				request.inStall = false;
				request.outputSpanMs += gap;
				counted = true;
			}
		} else {
			request.inStall = false;
		}
		this.recordArrival(request, now, kind, arrived, counted, samePhase && gap < BURST_BATCH_GAP_MS);
		request.lastPhase = request.phase;
		request.lastAt = now;
		request.lastKind = kind;

		if (kind === "thinking") {
			request.rawThinking += increment;
		} else {
			request.firstOutputAt ??= now;
			request.rawOutput += increment;
			request.outputAt.push(now);
			request.outputArrived.push(arrived);
		}
	}

	/** Deltas of one network read in the same phase are one arrival, so they share its interval. */
	private recordArrival(
		request: Request,
		now: number,
		kind: Kind,
		tokens: number,
		counted: boolean,
		sameRead: boolean,
	): void {
		const { live } = request;
		const last = live.at.length - 1;
		if (sameRead && last >= 0) {
			live.tokens[last] = (live.tokens[last] ?? 0) + tokens;
			return;
		}
		live.at.push(now);
		live.tokens.push(tokens);
		live.kinds.push(kind);
		live.counted.push(counted);
	}

	/** Live figures of the request in flight, computed at the current time; `requestNumber` is its place in the run. */
	snapshot(requestNumber = 1): LiveSnapshot | undefined {
		const request = this.request;
		if (!request) return undefined;
		const now = this.clock.now();
		const factor = factors(request.context);
		const { ratios } = request.context;
		const started = request.firstAt !== undefined || request.thinking !== "none";
		const snapshot: LiveSnapshot = {
			phase: started ? "streaming" : "waiting",
			provider: request.context.provider,
			model: request.context.model,
			request: requestNumber,
			elapsedMs: now - request.startAt,
			outputTokens: request.rawOutput * factor.output,
			thinking: request.thinking,
			calibrated: ratios.output !== undefined,
			thinkingCalibrated: ratios.thinking !== undefined,
			tpsCalibrated: true,
		};
		if (request.firstAt !== undefined) snapshot.ttftMs = request.firstAt - request.startAt;
		if (request.thinking !== "none") {
			snapshot.thinkingMs = request.thinkingMs + (request.block ? now - request.block.startAt : 0);
		}
		if (request.thinking === "streamed") snapshot.thinkingTokens = request.rawThinking * factor.thinking;
		const live = this.liveRate(request, now);
		if (live) {
			if (live.tps !== undefined) snapshot.liveTps = live.tps;
			snapshot.tpsCalibrated = [...live.kinds].every((kind) => ratios[kind] !== undefined);
		}
		return snapshot;
	}

	/**
	 * The live generation rate: calibrated tokens over counted time in the last 5 s. The time since the last delta
	 * counts while a thinking phase that streamed is open, or while output flows without a stall. An open thinking
	 * block that has streamed nothing yet has no rate.
	 */
	private liveRate(request: Request, now: number): { tps?: number; kinds: Set<Kind> } | undefined {
		if (request.block && !request.block.streamed) return undefined;
		const factor = factors(request.context);
		const figures = windowFigures(request.live, now - LIVE_WINDOW_MS, (kind) => factor[kind]);
		let counted = figures.ms;
		if (request.lastAt !== undefined && request.lastPhase === request.phase) {
			const since = Math.min(now - request.lastAt, LIVE_WINDOW_MS);
			if (request.lastKind === "thinking" || since < STALL_GAP_MS) counted += since;
		}
		if (counted < LIVE_MIN_COUNTED_MS) return { kinds: figures.kinds };
		return { tps: figures.tokens / (counted / 1000), kinds: figures.kinds };
	}

	/** The turn's assistant message ended. Produces a record for settled and aborted requests. */
	end(message: EndInput): EndOutcome {
		const request = this.request;
		if (!request) return { kind: "ignored" };
		this.request = undefined;
		this.turnClosed = true;
		const now = this.clock.now();
		closeBlock(request, now);
		switch (message.stopReason) {
			case "stop":
			case "length":
			case "toolUse":
				return settle(request, message, now, "settled");
			case "aborted":
				return settle(request, message, now, "aborted");
			default:
				return { kind: "errored" };
		}
	}
}

/**
 * Token count the few-batches criterion compares with the output deltas' batches: only tokens that arrived as output
 * deltas, never reasoning tokens (hidden reasoning arrives in no batch, a summary is not output).
 */
function burstStreamTokens(
	reportedOutput: number | undefined,
	reasoning: number | undefined,
	thinking: ThinkingKind,
	estimatedOutput: number,
): number {
	if (reportedOutput !== undefined) {
		if (reasoning !== undefined) return reportedOutput - reasoning;
		// Without a phase, everything reported was output; this keeps the "no deltas at all" burst case.
		if (thinking === "none") return reportedOutput;
	}
	// The residual of usage.output minus a thinking estimate would carry the whole estimation error of the thinking.
	return estimatedOutput;
}

function settle(request: Request, message: EndInput, now: number, outcome: "settled" | "aborted"): EndOutcome {
	const { usage } = message;
	const factor = factors(request.context);
	const elapsedMs = now - request.startAt;
	const reportedOutput = positive(usage.output) ? usage.output : undefined;
	const estimatedOutput = request.rawOutput * factor.output;
	const estimatedThinking = request.rawThinking * factor.thinking;
	const outputTokens = reportedOutput ?? Math.round(estimatedOutput + estimatedThinking);
	// Reasoning is a subset of the output; a larger figure is a provider error.
	const reasoning = usage.reasoning === undefined ? undefined : Math.min(count(usage.reasoning), outputTokens);
	// Only a positive count is a breakdown: OpenAI-compatible backends report 0 also when they streamed thinking.
	const breakdown = reasoning !== undefined && reasoning > 0 ? reasoning : undefined;
	const phaseObserved = request.thinking !== "none";

	let thinkingTokens: number | undefined = breakdown;
	if (thinkingTokens === undefined && request.thinking === "streamed") {
		thinkingTokens = Math.min(Math.round(estimatedThinking), outputTokens);
	}
	const visibleOutput = Math.max(0, outputTokens - (thinkingTokens ?? 0));
	// Without an observed phase the reasoning time is unknown (part of TTFT), so its tokens are not in the rate.
	const generatedTokens = phaseObserved ? outputTokens : outputTokens - (breakdown ?? 0);
	const generationMs = request.thinkingMs + request.outputSpanMs;

	let tps = generationMs >= MIN_SETTLED_SPAN_MS ? generatedTokens / (generationMs / 1000) : undefined;
	let outputTps =
		request.outputSpanMs >= MIN_SETTLED_SPAN_MS ? visibleOutput / (request.outputSpanMs / 1000) : undefined;
	let thinkingTps =
		thinkingTokens !== undefined && phaseObserved && request.thinkingMs >= MIN_SETTLED_SPAN_MS
			? thinkingTokens / (request.thinkingMs / 1000)
			: undefined;

	const burstReason =
		outcome === "settled"
			? classifyBurst(
					{ at: request.outputAt, tokens: request.outputArrived },
					burstStreamTokens(reportedOutput, breakdown, request.thinking, estimatedOutput),
					tps,
				)
			: undefined;
	let throughputTps: number | undefined;
	if (burstReason !== undefined) {
		tps = undefined;
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
		// Rounded down so that a time below the 1 s threshold stays below it after persistence.
		outputMs: Math.floor(request.outputSpanMs),
		generationMs: Math.floor(generationMs),
		generatedTokens,
		thinking: request.thinking,
		estimated: reportedOutput === undefined,
		inputTokens: count(usage.input),
		outputTokens,
		cacheReadTokens: count(usage.cacheRead),
		cacheWriteTokens: count(usage.cacheWrite),
		deltaCount: request.deltaCount,
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
	if (tps !== undefined) record.tps = round(tps, 2);
	if (outputTps !== undefined) record.outputTps = round(outputTps, 2);
	if (thinkingTps !== undefined) record.thinkingTps = round(thinkingTps, 2);
	if (throughputTps !== undefined) record.throughputTps = round(throughputTps, 2);
	if (phaseObserved) record.thinkingMs = Math.floor(request.thinkingMs);
	if (thinkingTokens !== undefined) record.thinkingTokens = thinkingTokens;
	if (reasoning !== undefined) record.reasoningTokens = reasoning;
	if (positive(usage.cost.total)) record.cost = usage.cost.total;
	if (message.durationMs !== undefined) {
		const skew = message.durationMs - elapsedMs;
		if (Math.abs(skew) > CLOCK_SKEW_THRESHOLD_MS) record.clockSkewMs = round(skew, 0);
	}

	if (outcome !== "settled" || burstReason !== undefined || reportedOutput === undefined) {
		return { kind: "recorded", record, calibration: {} };
	}
	// With a reasoning breakdown, compare visible output only: streamed thinking is often a summary or hidden, so its
	// raw estimate does not correspond to the reasoning tokens in usage.output. Without one, compare the total.
	const calibration: CalibrationSamples = {
		output:
			breakdown !== undefined
				? { reported: reportedOutput - breakdown, estimated: request.rawOutput }
				: { reported: reportedOutput, estimated: request.rawOutput + request.rawThinking },
	};
	if (breakdown !== undefined && request.thinking === "streamed") {
		calibration.thinking = { reported: breakdown, estimated: request.rawThinking };
	}
	return { kind: "recorded", record, calibration };
}
