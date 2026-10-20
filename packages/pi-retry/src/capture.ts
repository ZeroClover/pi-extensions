import type { Capture } from "./classify.ts";

/** The Pi settings the gate depends on, read from `pi.getSettings()` when a failure is evaluated. */
export interface GateSettings {
	cacheWarming?: string | undefined;
	providerMaxRetries?: number | undefined;
}

export type GateState = { open: true } | { open: false; reason: string };

/** Its own retry loop calls `onResponse` per attempt, so one call can yield several response events. */
const MULTI_RESPONSE_API = "openai-codex-responses";

/**
 * Attributes an `after_provider_response` event to the failed request only when one foreground request provably
 * yields one response event: no prompt-cache warming shares the hook, no provider-level retries run inside a call,
 * and the adapter makes one HTTP call per request. The window runs from the request's `context` event to its
 * assistant `message_end`; captures are never matched by message identity.
 */
export class HeaderCapture {
	private warmingSeen = false;
	private closedReason: string | undefined;
	private window: Capture[] | undefined;
	private snapshot: Capture | undefined;

	/** The gate state for the session, before the failed message's adapter is known. */
	gate(settings: GateSettings): GateState {
		if (this.closedReason) return { open: false, reason: this.closedReason };
		if (settings.cacheWarming !== "off") return { open: false, reason: "cacheWarming is not off" };
		if (this.warmingSeen) return { open: false, reason: "a cache-warming request ran in this session" };
		if ((settings.providerMaxRetries ?? 0) !== 0) return { open: false, reason: "retry.provider.maxRetries is not 0" };
		return { open: true };
	}

	gateFor(settings: GateSettings, api: string): GateState {
		const state = this.gate(settings);
		if (state.open && api === MULTI_RESPONSE_API) return { open: false, reason: `${api} retries inside one request` };
		return state;
	}

	/** `cache_warming_decision`: warming requests share the response hook for the rest of the session. */
	warmingDecision(): void {
		this.warmingSeen = true;
	}

	/** `context`: the agent is about to send a request; a new window opens. */
	requestStart(): void {
		this.window = [];
		this.snapshot = undefined;
	}

	/** `after_provider_response`. */
	response(capture: Capture): void {
		this.window?.push(capture);
	}

	/**
	 * Assistant `message_end`: closes the window and keeps its single error capture for the settlement that follows.
	 * More than one capture under an open gate disproves the gate's assumptions and closes it for the session.
	 */
	requestEnd(settings: GateSettings, api: string): void {
		const captures = this.window;
		this.window = undefined;
		this.snapshot = undefined;
		if (!captures || !this.gateFor(settings, api).open) return;
		if (captures.length > 1) {
			this.closedReason = "several responses arrived for one request";
			return;
		}
		const [only] = captures;
		if (only && only.status >= 400) this.snapshot = only;
	}

	/** The error capture of the request that ended last, if the gate attributed one to it. */
	take(): Capture | undefined {
		const capture = this.snapshot;
		this.snapshot = undefined;
		return capture;
	}

	reset(): void {
		this.warmingSeen = false;
		this.closedReason = undefined;
		this.window = undefined;
		this.snapshot = undefined;
	}
}
