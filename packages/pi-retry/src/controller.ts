import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ProjectedSessionEntry,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { type Random, retryDelay } from "./backoff.ts";
import { type GateSettings, type GateState, HeaderCapture } from "./capture.ts";
import { type Capture, classify } from "./classify.ts";
import type { RetryConfig } from "./config.ts";
import { formatDuration, formatRemaining } from "./format.ts";
import { waitFor } from "./wait.ts";

export const STATUS_KEY = "pi-retry";
export const RECORD_TYPE = "pi-retry";

export const LAYERING_NOTICE =
	'pi-retry: Pi\'s built-in retry is enabled and runs first; set "retry": { "enabled": false } in Pi settings to let pi-retry govern every attempt';
export const CANCELLED_NOTICE = "pi-retry: retry cancelled";

/** The machine-readable session record of one retry. */
export interface RetryRecord {
	attempt: number;
	category: string;
	reason: string;
	delayMs: number;
	hintSource?: string;
	provider: string;
	model: string;
	outcome: "scheduled" | "cancelled";
}

export interface WaitingState {
	attempt: number;
	endsAt: number;
	reason: string;
	/** A provider-hinted wait keeps its deadline when a message is queued. */
	hinted: boolean;
}

type Level = "info" | "warning" | "error";

/** What the settlement handler needs from Pi, so the controller is testable without a session. */
export interface SettleEnvironment {
	notify(message: string, level: Level): void;
	setStatus(text: string | undefined): void;
	hasPendingMessages(): boolean;
	abort(): void;
	/** Raw terminal input in interactive mode, a no-op elsewhere; returns the unsubscribe function. */
	onTerminalInput(handler: (data: string) => undefined): () => void;
	gateSettings: GateSettings;
	now(): number;
	random: Random;
}

export interface ControllerHooks {
	/** Appends a session entry outside model context (`pi.appendEntry`). */
	appendRecord(record: RetryRecord): void;
}

type ProjectedMessage = ProjectedSessionEntry["messages"][number];

function isFailedAssistant(message: ProjectedMessage | undefined): message is AssistantMessage {
	return message?.role === "assistant" && message.stopReason === "error";
}

/**
 * The entry that holds the failed assistant message: the last projected entry that still contributes a message to
 * model context and whose last contribution is an error assistant message. An entry an earlier handler already omitted
 * contributes nothing and is skipped.
 */
export function findFailedEntry(
	entries: readonly ProjectedSessionEntry[],
): { targetId: string; message: AssistantMessage } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || entry.messages.length === 0) continue;
		const source = entry.sourceEntry;
		if (source.type !== "message" || !isFailedAssistant(entry.messages.at(-1))) return undefined;
		return isFailedAssistant(source.message) ? { targetId: source.id, message: source.message } : undefined;
	}
	return undefined;
}

/** Why a wait ended without a retry. */
type CancelSource = "command" | "escape" | "shutdown" | "switch";

interface ActiveWait extends WaitingState {
	cancelledBy?: CancelSource;
	wake: AbortController;
}

/**
 * Session state of pi-retry: the attempt budget, the enable flag, the wait in progress and the header capture.
 * The settlement handler is the only writer of the waiting state.
 */
export class RetryController {
	config: RetryConfig;
	enabledForSession: boolean;
	attempt = 0;
	readonly capture = new HeaderCapture();
	private active: ActiveWait | undefined;
	/** A retry whose drafts were returned and whose request has not started yet. */
	private pending: RetryRecord | undefined;

	constructor(
		config: RetryConfig,
		private readonly hooks: ControllerHooks,
	) {
		this.config = config;
		this.enabledForSession = config.enabled;
	}

	/** `session_start`: a fresh state with the newly read configuration. */
	reset(config: RetryConfig): void {
		this.config = config;
		this.enabledForSession = config.enabled;
		this.attempt = 0;
		this.capture.reset();
		this.pending = undefined;
	}

	/** Whether failures are retried: `enabled` from the file, until `/retry on` or `/retry off` changes it. */
	get enabled(): boolean {
		return this.enabledForSession;
	}

	get waiting(): WaitingState | undefined {
		if (!this.active) return undefined;
		const { attempt, endsAt, reason, hinted } = this.active;
		return { attempt, endsAt, reason, hinted };
	}

	gate(settings: GateSettings): GateState {
		return this.capture.gate(settings);
	}

	/** Ends the wait in progress without retrying. Returns whether there was one. */
	cancel(source: CancelSource): boolean {
		if (!this.active || this.active.cancelledBy) return false;
		this.active.cancelledBy = source;
		this.active.wake.abort();
		return true;
	}

	setEnabled(enabled: boolean): void {
		this.enabledForSession = enabled;
		if (!enabled) this.cancel("command");
	}

	/** `before_agent_start`: a new user prompt starts a new sequence. */
	promptStart(): void {
		this.attempt = 0;
	}

	/**
	 * Assistant `message_end`. Returns the success notification when a retried request succeeded. Errors keep the
	 * count for the settlement that follows; aborts reset it silently.
	 */
	messageEnd(message: AssistantMessage, settings: GateSettings): string | undefined {
		this.capture.requestEnd(settings, message.api);
		this.pending = undefined;
		if (message.stopReason === "error") return undefined;
		const attempt = this.attempt;
		this.attempt = 0;
		if (message.stopReason === "aborted" || attempt === 0) return undefined;
		return `pi-retry: succeeded on retry ${attempt}`;
	}

	/** `agent_settled`. An aborted run whose retry never started gets its record corrected to `cancelled`. */
	settled(aborted: boolean): void {
		const pending = this.pending;
		this.pending = undefined;
		if (!aborted) return;
		this.attempt = 0;
		if (pending) this.hooks.appendRecord({ ...pending, outcome: "cancelled" });
	}

	/** `agent_before_settle`: decides, waits and returns the continuation, or returns nothing. */
	async beforeSettle(
		event: Pick<AgentBeforeSettleEvent, "outcome" | "continue" | "entries" | "context">,
		env: SettleEnvironment,
	): Promise<BoundaryResult | undefined> {
		if (event.outcome !== "error" || event.continue || !this.enabled) return undefined;
		if (!isFailedAssistant(event.context.contextMessages.at(-1))) return undefined;
		if (event.entries.some((draft) => draft.type === "compaction")) return undefined;
		const target = findFailedEntry(event.context.contextEntries);
		if (!target) throw new Error("pi-retry: the failed assistant message has no session entry to omit; not retrying");

		const capture: Capture | undefined = this.capture.take();
		const { config } = this;
		const classification = classify(
			{
				message: target.message,
				capture: this.capture.gateFor(env.gateSettings, target.message.api).open ? capture : undefined,
			},
			{ patterns: config.patterns, maxRetryAfterMs: config.maxRetryAfterMs, now: env.now() },
		);
		if (!classification.retryable) {
			this.attempt = 0;
			env.notify(`pi-retry: not retrying: ${classification.reason}`, "warning");
			return undefined;
		}
		if (this.attempt >= config.maxRetries) {
			this.attempt = 0;
			env.notify(`pi-retry: giving up after ${config.maxRetries} retries: ${classification.reason}`, "warning");
			return undefined;
		}

		const attempt = this.attempt + 1;
		const delayMs = retryDelay(classification, config, attempt, env.random);
		const hinted = classification.hint !== undefined;
		const progress = `retry ${attempt}/${config.maxRetries}`;
		env.notify(
			`pi-retry: ${classification.category} (${classification.reason}); ${progress} in ${formatDuration(delayMs)}`,
			"info",
		);

		const active: ActiveWait = {
			attempt,
			endsAt: env.now() + delayMs,
			reason: classification.reason,
			hinted,
			wake: new AbortController(),
		};
		this.active = active;
		const unsubscribe = env.onTerminalInput((data) => {
			// Not consumed: Pi's own Escape handling still requests the run abort.
			if (matchesKey(data, "escape")) this.cancel("escape");
			return undefined;
		});
		let outcome: Awaited<ReturnType<typeof waitFor>>;
		try {
			outcome = await waitFor(delayMs, {
				shouldStop: () => {
					if (active.cancelledBy) return "cancel";
					return !hinted && env.hasPendingMessages() ? "proceed" : undefined;
				},
				onTick: (remainingMs) => env.setStatus(`${progress} in ${formatRemaining(remainingMs)}`),
				now: env.now,
				wake: active.wake.signal,
			});
		} finally {
			unsubscribe();
			if (this.active === active) this.active = undefined;
			// After a shutdown the handler's context may be stale; the shutdown handler has cleaned up.
			if (active.cancelledBy !== "shutdown") env.setStatus(undefined);
		}

		if (outcome === "cancelled") {
			this.attempt = 0;
			if (active.cancelledBy !== "shutdown") {
				// Without the abort Pi would still continue on queued messages before the provider's deadline.
				env.abort();
				env.notify(CANCELLED_NOTICE, "info");
			}
			return undefined;
		}

		const record: RetryRecord = {
			attempt,
			category: classification.category,
			reason: classification.reason,
			delayMs,
			...(classification.hint ? { hintSource: classification.hint.source } : {}),
			provider: target.message.provider,
			model: target.message.model,
			outcome: "scheduled",
		};
		this.attempt = attempt;
		this.pending = record;
		const entries: SessionBoundaryDraft[] = [
			...event.entries,
			{ type: "context_edit", targetId: target.targetId, replacement: null },
			{ type: "custom", customType: RECORD_TYPE, data: record },
		];
		return { entries, continue: true };
	}
}
