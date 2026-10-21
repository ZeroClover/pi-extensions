import {
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	type JsonObject,
	type Message,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";

export const PROVIDER_ID = "scripted";
const API = "scripted";

/**
 * One streamed unit of the scripted text. A short word is one token for common estimators, so a rate in tokens per
 * second is also the rate an extension estimates from the deltas.
 */
const TOKEN = " word";

/** What the script does next inside one response. */
export type Step =
	| { kind: "pause"; ms: number }
	| { kind: "text"; text: string }
	| { kind: "tokens"; count: number; tokensPerSecond?: number | undefined }
	| { kind: "thinking"; count: number; tokensPerSecond?: number | undefined }
	| { kind: "hiddenThinking"; ms: number }
	| { kind: "toolCall"; name: string; arguments: JsonObject };

/** One scripted response. Without an `error` it ends like a successful provider response. */
export interface Response {
	steps: Step[];
	/** Status and headers passed to `onResponse`; 200 and no headers by default. */
	status?: number | undefined;
	headers?: Record<string, string> | undefined;
	/** Reported usage; `output` defaults to the streamed tokens and `input` to 0. */
	usage?: Partial<Pick<Usage, "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite">> | undefined;
	/** The serving model the message names, when it differs from the requested one (a virtual model). */
	model?: string | undefined;
	responseModel?: string | undefined;
	/** Ends the response with `stopReason: "error"` and this `errorMessage`, after the steps. */
	error?: string | undefined;
	/** Diagnostics a provider adapter attaches to a failed message, such as Bedrock's `details.errorCode`. */
	diagnostics?: AssistantMessageDiagnostic[] | undefined;
}

/** A request the provider received. */
export interface ProviderRequest {
	/** The requested model id. */
	model: string;
	context: TranscriptContext;
	/** `performance.now()` when the request arrived and when its response ended. */
	startedAt: number;
	endedAt?: number;
}

export type Scripted = Response | ((request: ProviderRequest) => Response);

export function pause(ms: number): Step {
	return { kind: "pause", ms };
}

/** Literal text, sent as one delta. */
export function text(content: string): Step {
	return { kind: "text", text: content };
}

/** `count` output tokens, one per delta at `tokensPerSecond`, or all in one delta (a buffered flush) without a rate. */
export function tokens(count: number, options: { tokensPerSecond?: number } = {}): Step {
	return { kind: "tokens", count, tokensPerSecond: options.tokensPerSecond };
}

/** `count` streamed thinking tokens, one per delta at `tokensPerSecond`. */
export function thinking(count: number, options: { tokensPerSecond?: number } = {}): Step {
	return { kind: "thinking", count, tokensPerSecond: options.tokensPerSecond };
}

/** A thinking block that streams no delta for `ms`, as hidden or encrypted reasoning does. */
export function hiddenThinking(ms: number): Step {
	return { kind: "hiddenThinking", ms };
}

export function toolCall(name: string, args: JsonObject): Step {
	return { kind: "toolCall", name, arguments: args };
}

/** A successful response made of `steps`. */
export function reply(steps: Step | Step[], options: Omit<Response, "steps" | "error"> = {}): Response {
	return { ...options, steps: Array.isArray(steps) ? steps : [steps] };
}

/** A failed request: `onResponse` reports `status` and `headers`, then the stream ends with `message`. */
export function failure(
	message: string,
	options: {
		status?: number;
		headers?: Record<string, string>;
		steps?: Step[];
		diagnostics?: AssistantMessageDiagnostic[];
	} = {},
): Response {
	return {
		steps: options.steps ?? [],
		status: options.status,
		headers: options.headers,
		error: message,
		diagnostics: options.diagnostics,
	};
}

/** The non-system messages of a request, as the model saw them. */
export function conversation(request: ProviderRequest): Message[] {
	return request.context.messages.filter((message) => message.role !== "system");
}

export interface ScriptedProvider {
	readonly provider: Provider;
	/** The registered models; a session starts on the first. */
	readonly models: readonly [Model<string>, Model<string>];
	/** Every request received, in order. */
	readonly requests: ProviderRequest[];
	/** Queues responses; each request takes the next one. */
	respond(...responses: Scripted[]): void;
	/** Responses still queued. */
	pending(): number;
}

function model(id: string, name: string): Model<string> {
	return {
		id,
		name,
		api: API,
		provider: PROVIDER_ID,
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

/** Resolves once `performance.now() >= at`, or at once when `signal` aborts. */
async function sleepUntil(at: number, signal: AbortSignal | undefined): Promise<void> {
	// A timer can fire a fraction of a millisecond before `performance.now()` reaches its due time; scripted delays
	// are lower bounds that tests assert on, so sleep again for the rest.
	while (performance.now() < at && !signal?.aborted) {
		await new Promise<void>((resolve) => {
			const onAbort = (): void => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(
				() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				Math.max(1, at - performance.now()),
			);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}

type Block = { kind: "text"; index: number } | { kind: "thinking"; index: number };

class Streamer {
	private readonly out: AssistantMessageEventStream;
	private readonly signal: AbortSignal | undefined;
	private readonly partial: AssistantMessage;
	private block: Block | undefined;
	private streamed = 0;

	constructor(
		out: AssistantMessageEventStream,
		signal: AbortSignal | undefined,
		requested: Model<string>,
		response: Response,
	) {
		this.out = out;
		this.signal = signal;
		this.partial = {
			role: "assistant",
			content: [],
			api: requested.api,
			provider: requested.provider,
			model: response.model ?? requested.id,
			...(response.responseModel === undefined ? {} : { responseModel: response.responseModel }),
			usage: usage({}, 0),
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	get aborted(): boolean {
		return this.signal?.aborted === true;
	}

	start(): void {
		this.out.push({ type: "start", partial: this.snapshot() });
	}

	private snapshot(): AssistantMessage {
		return { ...this.partial, content: this.partial.content.map((block) => ({ ...block })) };
	}

	private closeBlock(): void {
		const block = this.block;
		if (!block) return;
		this.block = undefined;
		const content = this.partial.content[block.index];
		if (block.kind === "text" && content?.type === "text") {
			this.out.push({ type: "text_end", contentIndex: block.index, content: content.text, partial: this.snapshot() });
		} else if (block.kind === "thinking" && content?.type === "thinking") {
			this.out.push({
				type: "thinking_end",
				contentIndex: block.index,
				content: content.thinking,
				partial: this.snapshot(),
			});
		}
	}

	private openBlock(kind: Block["kind"]): number {
		if (this.block?.kind === kind) return this.block.index;
		this.closeBlock();
		const index = this.partial.content.length;
		const content: TextContent | ThinkingContent =
			kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
		this.partial.content.push(content);
		this.block = { kind, index };
		this.out.push({
			type: kind === "text" ? "text_start" : "thinking_start",
			contentIndex: index,
			partial: this.snapshot(),
		});
		return index;
	}

	private delta(kind: Block["kind"], delta: string, count: number): void {
		const index = this.openBlock(kind);
		const content = this.partial.content[index];
		if (content?.type === "text") content.text += delta;
		else if (content?.type === "thinking") content.thinking += delta;
		this.streamed += count;
		const type = kind === "text" ? "text_delta" : "thinking_delta";
		this.out.push({ type, contentIndex: index, delta, partial: this.snapshot() });
	}

	async run(step: Step): Promise<void> {
		switch (step.kind) {
			case "pause":
				await sleepUntil(performance.now() + step.ms, this.signal);
				return;
			case "text":
				this.delta("text", step.text, step.text.trim() === "" ? 0 : step.text.trim().split(/\s+/).length);
				return;
			case "tokens":
			case "thinking": {
				const kind = step.kind === "tokens" ? "text" : "thinking";
				const rate = step.tokensPerSecond;
				if (rate === undefined || rate <= 0) {
					this.delta(kind, TOKEN.repeat(step.count), step.count);
					return;
				}
				// Delta i is due at a fixed offset from the step start, so timer delays do not accumulate.
				const startAt = performance.now();
				for (let i = 0; i < step.count; i++) {
					await sleepUntil(startAt + (i * 1000) / rate, this.signal);
					if (this.aborted) return;
					this.delta(kind, TOKEN, 1);
				}
				return;
			}
			case "hiddenThinking":
				this.closeBlock();
				this.openBlock("thinking");
				await sleepUntil(performance.now() + step.ms, this.signal);
				this.closeBlock();
				return;
			case "toolCall": {
				this.closeBlock();
				const index = this.partial.content.length;
				const call: ToolCall = {
					type: "toolCall",
					id: `call-${Math.random().toString(36).slice(2, 10)}`,
					name: step.name,
					arguments: {},
				};
				this.partial.content.push(call);
				this.out.push({ type: "toolcall_start", contentIndex: index, partial: this.snapshot() });
				this.out.push({
					type: "toolcall_delta",
					contentIndex: index,
					delta: JSON.stringify(step.arguments),
					partial: this.snapshot(),
				});
				call.arguments = step.arguments;
				this.out.push({ type: "toolcall_end", contentIndex: index, toolCall: { ...call }, partial: this.snapshot() });
				return;
			}
		}
	}

	/** Ends the response; `error` makes it a failed one. */
	finish(response: Response): void {
		this.closeBlock();
		if (this.aborted) {
			this.abort();
			return;
		}
		this.partial.usage = usage(response.usage ?? {}, this.streamed);
		if (response.error !== undefined) {
			const message: AssistantMessage = {
				...this.snapshot(),
				stopReason: "error",
				errorMessage: response.error,
				...(response.diagnostics === undefined ? {} : { diagnostics: response.diagnostics }),
			};
			this.out.push({ type: "error", reason: "error", error: message });
			this.out.end(message);
			return;
		}
		const hasToolCall = this.partial.content.some((block) => block.type === "toolCall");
		const reason = hasToolCall ? "toolUse" : "stop";
		const message: AssistantMessage = { ...this.snapshot(), stopReason: reason };
		this.out.push({ type: "done", reason, message });
		this.out.end(message);
	}

	abort(): void {
		this.closeBlock();
		const message: AssistantMessage = {
			...this.snapshot(),
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		};
		this.out.push({ type: "error", reason: "aborted", error: message });
		this.out.end(message);
	}
}

function usage(reported: NonNullable<Response["usage"]>, streamed: number): Usage {
	const input = reported.input ?? 0;
	const output = reported.output ?? streamed;
	const cacheRead = reported.cacheRead ?? 0;
	const cacheWrite = reported.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reported.reasoning === undefined ? {} : { reasoning: reported.reasoning }),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * A provider that plays scripted responses through Pi's real request path: every request calls `onPayload` (which
 * emits `before_provider_request`) and `onResponse` (`after_provider_response`) before it streams, like Pi's built-in
 * providers do, and the stream honours the abort signal.
 */
export function createScriptedProvider(): ScriptedProvider {
	const queue: Scripted[] = [];
	const requests: ProviderRequest[] = [];
	const models: [Model<string>, Model<string>] = [model("a", "Scripted A"), model("b", "Scripted B")];

	const stream = (requested: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) => {
		const out = createAssistantMessageEventStream();
		const request: ProviderRequest = { model: requested.id, context, startedAt: performance.now() };
		requests.push(request);
		const next = queue.shift();
		void (async () => {
			const response: Response =
				next === undefined
					? failure("scripted provider: no response queued")
					: typeof next === "function"
						? next(request)
						: next;
			const streamer = new Streamer(out, options?.signal, requested, response);
			try {
				await options?.onPayload?.({ model: requested.id, messages: context.messages }, requested);
				await options?.onResponse?.({ status: response.status ?? 200, headers: response.headers ?? {} }, requested);
				if (streamer.aborted) {
					streamer.abort();
					return;
				}
				if (response.steps.length > 0 || response.error === undefined) streamer.start();
				for (const step of response.steps) {
					await streamer.run(step);
					if (streamer.aborted) break;
				}
				streamer.finish(response);
			} catch (error) {
				streamer.finish({ steps: [], error: error instanceof Error ? error.message : String(error) });
			} finally {
				request.endedAt = performance.now();
			}
		})();
		return out;
	};

	const provider = createProvider({
		id: PROVIDER_ID,
		name: "Scripted",
		auth: { apiKey: { name: "Scripted", resolve: async () => ({ auth: {} }) } },
		models,
		api: { stream, streamSimple: stream },
	});

	return {
		provider,
		models,
		requests,
		respond: (...responses) => {
			queue.push(...responses);
		},
		pending: () => queue.length,
	};
}
