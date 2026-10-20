import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ProjectedSessionEntry,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type RetryConfig } from "../src/config.ts";
import {
	CANCELLED_NOTICE,
	findFailedEntry,
	RetryController,
	type RetryRecord,
	type SettleEnvironment,
} from "../src/controller.ts";
import { assistant, failure } from "./fixtures.ts";

type SettleEvent = Pick<AgentBeforeSettleEvent, "outcome" | "continue" | "entries" | "context">;

const USER = { role: "user" as const, content: "hello", timestamp: 0 };
const RATE_LIMIT = "429 Too Many Requests";

/** A projected message whose source is not a message entry (here a custom message), so it cannot be omitted as one. */
function foreignEntry(id: string, message: ProjectedSessionEntry["messages"][number]): ProjectedSessionEntry {
	return {
		sourceEntry: {
			type: "custom_message",
			id,
			parentId: null,
			timestamp: "",
			customType: "x",
			content: "",
			display: false,
		},
		messages: [message],
	};
}

function entry(id: string, message: ProjectedSessionEntry["messages"][number]): ProjectedSessionEntry {
	return { sourceEntry: { type: "message", id, parentId: null, timestamp: "", message }, messages: [message] };
}

/** A settlement event whose projection ends with `failed`. */
function settleEvent(
	failed: AssistantMessage,
	options: { drafts?: SessionBoundaryDraft[]; continue?: boolean } = {},
): SettleEvent {
	const contextEntries = [entry("u1", USER), entry("a1", failed)];
	return {
		outcome: "error",
		continue: options.continue ?? false,
		entries: options.drafts ?? [],
		context: {
			contextEntries,
			contextMessages: contextEntries.flatMap((projected) => projected.messages),
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		},
	};
}

class FakePi {
	notes: [string, string][] = [];
	statuses: (string | undefined)[] = [];
	aborts = 0;
	pending = false;
	subscribed = 0;
	unsubscribed = 0;
	records: RetryRecord[] = [];
	private terminal: ((data: string) => undefined) | undefined;
	readonly env: SettleEnvironment = {
		notify: (message, level) => this.notes.push([message, level]),
		setStatus: (text) => this.statuses.push(text),
		hasPendingMessages: () => this.pending,
		abort: () => {
			this.aborts++;
		},
		onTerminalInput: (handler) => {
			this.subscribed++;
			this.terminal = handler;
			return () => {
				this.unsubscribed++;
				this.terminal = undefined;
			};
		},
		gateSettings: { cacheWarming: "streaming" },
		now: () => Date.now(),
		random: () => 1,
	};

	press(data: string): void {
		this.terminal?.(data);
	}

	messages(): string[] {
		return this.notes.map(([message]) => message);
	}
}

function setup(overrides: Partial<RetryConfig> = {}): { controller: RetryController; pi: FakePi } {
	const pi = new FakePi();
	const controller = new RetryController(
		{ ...defaultConfig(), ...overrides },
		{ appendRecord: (record) => pi.records.push(record) },
	);
	return { controller, pi };
}

/** Runs one settlement to its end, advancing fake time through the wait. */
async function settle(
	controller: RetryController,
	pi: FakePi,
	event: SettleEvent,
): Promise<BoundaryResult | undefined> {
	const result = controller.beforeSettle(event, pi.env);
	await vi.runAllTimersAsync();
	return result;
}

/** One failed request as Pi reports it: the assistant `message_end`, then the boundary. */
async function fail(controller: RetryController, pi: FakePi, text = RATE_LIMIT): Promise<BoundaryResult | undefined> {
	const message = failure(text);
	controller.messageEnd(message, pi.env.gateSettings);
	return settle(controller, pi, settleEvent(message));
}

beforeEach(() => {
	vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("findFailedEntry", () => {
	it("finds the last contributing entry and skips entries an earlier handler omitted", () => {
		const first = failure("first");
		const second = failure("second");
		const omitted: ProjectedSessionEntry = { ...entry("a2", second), messages: [] };
		const entries = [entry("u1", USER), entry("a1", first), omitted];
		expect(findFailedEntry(entries)).toEqual({ targetId: "a1", message: first });
	});

	it("returns nothing when the tail is not a failed assistant message", () => {
		expect(findFailedEntry([entry("a1", failure("x")), entry("u2", USER)])).toBeUndefined();
		expect(findFailedEntry([entry("a1", assistant("stop"))])).toBeUndefined();
		expect(findFailedEntry([])).toBeUndefined();
	});

	it("returns nothing when the projected message has no message source entry", () => {
		expect(findFailedEntry([foreignEntry("a1", failure("x"))])).toBeUndefined();
	});
});

describe("RetryController: trigger", () => {
	it("Failure reaches settlement: returns the boundary result after the wait", async () => {
		const { controller, pi } = setup();
		const failed = failure(RATE_LIMIT);
		const result = await settle(controller, pi, settleEvent(failed));
		const record: RetryRecord = {
			attempt: 1,
			category: "rate_limit",
			reason: "rate_limit: HTTP 429",
			delayMs: 2000,
			provider: "anthropic",
			model: "claude-test",
			outcome: "scheduled",
		};
		expect(result).toEqual({
			entries: [
				{ type: "context_edit", targetId: "a1", replacement: null },
				{ type: "custom", customType: "pi-retry", data: record },
			],
			continue: true,
		});
		expect(pi.messages()).toEqual(["pi-retry: rate_limit (rate_limit: HTTP 429); retry 1/10 in 2s"]);
		expect(pi.notes[0]?.[1]).toBe("info");
		expect(controller.attempt).toBe(1);
	});

	it("Another extension continues", async () => {
		const { controller, pi } = setup();
		expect(await settle(controller, pi, settleEvent(failure(RATE_LIMIT), { continue: true }))).toBeUndefined();
		expect(pi.notes).toEqual([]);
	});

	it("ignores outcomes other than error", async () => {
		const { controller, pi } = setup();
		expect(await settle(controller, pi, { ...settleEvent(failure(RATE_LIMIT)), outcome: "completed" })).toBeUndefined();
	});

	it("Aborted message: no classification and no retry", async () => {
		const { controller, pi } = setup();
		expect(await settle(controller, pi, settleEvent(assistant("aborted")))).toBeUndefined();
		expect(pi.notes).toEqual([]);
	});

	it("Compaction drafted by another handler", async () => {
		const { controller, pi } = setup();
		const drafts: SessionBoundaryDraft[] = [{ type: "compaction", summary: "s", firstKeptEntryId: null }];
		expect(await settle(controller, pi, settleEvent(failure(RATE_LIMIT), { drafts }))).toBeUndefined();
	});

	it("Earlier handler drafts survive", async () => {
		const { controller, pi } = setup();
		const earlier: SessionBoundaryDraft = { type: "context_edit", targetId: "u1", replacement: { content: "edited" } };
		const result = await settle(controller, pi, settleEvent(failure(RATE_LIMIT), { drafts: [earlier] }));
		expect(result?.entries?.[0]).toBe(earlier);
		expect(result?.entries?.[1]).toEqual({ type: "context_edit", targetId: "a1", replacement: null });
		expect(result?.entries).toHaveLength(3);
	});

	it("reports an error instead of continuing when the failed message has no session entry", async () => {
		const { controller, pi } = setup();
		const failed = failure(RATE_LIMIT);
		const event = settleEvent(failed);
		event.context.contextEntries = [foreignEntry("a1", failed)];
		await expect(controller.beforeSettle(event, pi.env)).rejects.toThrow(/no session entry/);
	});

	it("does nothing while disabled, and Off then on", async () => {
		const { controller, pi } = setup();
		controller.setEnabled(false);
		expect(await fail(controller, pi)).toBeUndefined();
		controller.setEnabled(true);
		expect(await fail(controller, pi)).toMatchObject({ continue: true });
	});

	it("starts disabled with enabled: false in the file", async () => {
		const { controller, pi } = setup({ enabled: false });
		expect(await fail(controller, pi)).toBeUndefined();
	});

	it("does not retry a non-retryable failure", async () => {
		const { controller, pi } = setup();
		expect(await fail(controller, pi, "401 Unauthorized")).toBeUndefined();
		expect(pi.notes).toEqual([["pi-retry: not retrying: auth: Unauthorized", "warning"]]);
	});

	it("uses the header capture when the gate is open", async () => {
		const { controller, pi } = setup();
		pi.env.gateSettings = { cacheWarming: "off" };
		const failed = assistant("error", "429 Too Many Requests", { api: "mistral-conversations" });
		controller.capture.requestStart();
		controller.capture.response({ status: 429, headers: { "retry-after": "45" } });
		controller.messageEnd(failed, pi.env.gateSettings);
		const result = await settle(controller, pi, settleEvent(failed));
		expect(result?.entries?.[1]).toMatchObject({
			data: { delayMs: 45_250, hintSource: "header retry-after" },
		});
	});
});

describe("RetryController: budget", () => {
	it("Budget exhausted", async () => {
		const { controller, pi } = setup({ maxRetries: 3 });
		for (let attempt = 1; attempt <= 3; attempt++) expect(await fail(controller, pi)).toMatchObject({ continue: true });
		expect(await fail(controller, pi)).toBeUndefined();
		expect(pi.notes.at(-1)).toEqual(["pi-retry: giving up after 3 retries: rate_limit: HTTP 429", "warning"]);
	});

	it("Second failure and Success after retry", async () => {
		const { controller, pi } = setup();
		await fail(controller, pi);
		const second = await fail(controller, pi);
		expect(second?.entries?.[1]).toMatchObject({ data: { attempt: 2, delayMs: 4000 } });
		expect(controller.messageEnd(assistant("stop"), pi.env.gateSettings)).toBe("pi-retry: succeeded on retry 2");
		expect(controller.attempt).toBe(0);
	});

	it("Reset on success", async () => {
		const { controller, pi } = setup();
		await fail(controller, pi);
		await fail(controller, pi);
		controller.messageEnd(assistant("toolUse"), pi.env.gateSettings);
		const later = await fail(controller, pi);
		expect(later?.entries?.[1]).toMatchObject({ data: { attempt: 1 } });
	});

	it("does not report success when no retry was in flight", () => {
		const { controller, pi } = setup();
		expect(controller.messageEnd(assistant("stop"), pi.env.gateSettings)).toBeUndefined();
	});

	it("Aborted retry is not a success", async () => {
		const { controller, pi } = setup();
		await fail(controller, pi);
		expect(controller.messageEnd(assistant("aborted"), pi.env.gateSettings)).toBeUndefined();
		expect(controller.attempt).toBe(0);
	});

	it("Reset on new prompt", async () => {
		const { controller, pi } = setup({ maxRetries: 1 });
		await fail(controller, pi);
		expect(await fail(controller, pi)).toBeUndefined();
		controller.promptStart();
		expect((await fail(controller, pi))?.entries?.[1]).toMatchObject({ data: { attempt: 1 } });
	});

	it("resets when a run settles as aborted", async () => {
		const { controller, pi } = setup();
		await fail(controller, pi);
		controller.messageEnd(failure(RATE_LIMIT), pi.env.gateSettings);
		controller.settled(true);
		expect(controller.attempt).toBe(0);
	});

	it("Both retries enabled: 44 requests with Pi's retry renewing its budget before every continuation", async () => {
		const { controller, pi } = setup({ maxRetries: 10 });
		const piMaxRetries = 3;
		let requests = 0;
		let continuations = 0;
		for (;;) {
			// Pi's own retry: the first request and up to three Pi retries, each ending in an error message.
			for (let piAttempt = 0; piAttempt <= piMaxRetries; piAttempt++) {
				requests++;
				controller.messageEnd(failure(RATE_LIMIT), pi.env.gateSettings);
			}
			const result = await settle(controller, pi, settleEvent(failure(RATE_LIMIT)));
			if (!result) break;
			continuations++;
		}
		expect(requests).toBe(44);
		expect(continuations).toBe(10);
	});
});

describe("RetryController: wait", () => {
	it("Status line during the wait counts down and clears", async () => {
		const { controller, pi } = setup({ baseDelayMs: 30_000, maxBackoffMs: 30_000 });
		controller.attempt = 1;
		await settle(controller, pi, settleEvent(failure(RATE_LIMIT)));
		expect(pi.statuses[0]).toBe("retry 2/10 in 30s");
		expect(pi.statuses.at(-2)).toBe("retry 2/10 in 1s");
		expect(pi.statuses.at(-1)).toBeUndefined();
		expect(pi.statuses).toHaveLength(31);
	});

	it("exposes the waiting state while waiting", async () => {
		const { controller, pi } = setup();
		const done = controller.beforeSettle(settleEvent(failure(RATE_LIMIT)), pi.env);
		await vi.advanceTimersByTimeAsync(500);
		expect(controller.waiting).toMatchObject({ attempt: 1, reason: "rate_limit: HTTP 429", hinted: false });
		await vi.runAllTimersAsync();
		await done;
		expect(controller.waiting).toBeUndefined();
	});

	it("Cancel: the run is aborted, nothing is appended and the user is told", async () => {
		const { controller, pi } = setup({ baseDelayMs: 60_000 });
		const done = controller.beforeSettle(settleEvent(failure(RATE_LIMIT)), pi.env);
		await vi.advanceTimersByTimeAsync(5000);
		expect(controller.cancel("command")).toBe(true);
		await expect(done).resolves.toBeUndefined();
		expect(Date.now()).toBe(5000);
		expect(pi.aborts).toBe(1);
		expect(pi.notes.at(-1)).toEqual([CANCELLED_NOTICE, "info"]);
		expect(pi.records).toEqual([]);
		expect(pi.unsubscribed).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("Cancel with a queued message during a provider deadline", async () => {
		const { controller, pi } = setup();
		const failed = failure("429 rate limited, retry after 300 seconds");
		const done = controller.beforeSettle(settleEvent(failed), pi.env);
		pi.pending = true;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(controller.waiting?.hinted).toBe(true);
		controller.cancel("command");
		await vi.advanceTimersByTimeAsync(1000);
		await expect(done).resolves.toBeUndefined();
		expect(pi.aborts).toBe(1);
	});

	it("Escape in the terminal", async () => {
		const { controller, pi } = setup({ baseDelayMs: 60_000 });
		const done = controller.beforeSettle(settleEvent(failure(RATE_LIMIT)), pi.env);
		await vi.advanceTimersByTimeAsync(2000);
		pi.press("a");
		expect(controller.waiting).toBeDefined();
		pi.press("\x1b");
		await expect(done).resolves.toBeUndefined();
		expect(Date.now()).toBe(2000);
		expect(pi.subscribed).toBe(1);
		expect(pi.unsubscribed).toBe(1);
		expect(pi.aborts).toBe(1);
		expect(pi.notes.at(-1)).toEqual([CANCELLED_NOTICE, "info"]);
	});

	it("Queued message during backoff: the retry proceeds within one second", async () => {
		const { controller, pi } = setup({ baseDelayMs: 60_000 });
		const done = controller.beforeSettle(settleEvent(failure(RATE_LIMIT)), pi.env);
		await vi.advanceTimersByTimeAsync(3000);
		pi.pending = true;
		await vi.advanceTimersByTimeAsync(1000);
		await expect(done).resolves.toMatchObject({ continue: true });
		expect(Date.now()).toBeLessThanOrEqual(4000);
	});

	it("Queued message during a provider deadline: the wait runs to the deadline", async () => {
		const { controller, pi } = setup();
		const failed = failure("429 rate limited, retry after 300 seconds");
		let settled = false;
		const done = controller.beforeSettle(settleEvent(failed), pi.env).then((result) => {
			settled = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(1000);
		pi.pending = true;
		await vi.advanceTimersByTimeAsync(298_000);
		expect(settled).toBe(false);
		expect(pi.statuses.at(-1)).toBe("retry 1/10 in 2s");
		await vi.advanceTimersByTimeAsync(1250);
		await expect(done).resolves.toMatchObject({ continue: true });
		expect(Date.now()).toBe(300_250);
	});

	it("Session switch or fork: the wait ends at once with an abort", async () => {
		const { controller, pi } = setup({ baseDelayMs: 60_000 });
		const done = controller.beforeSettle(settleEvent(failure(RATE_LIMIT)), pi.env);
		await vi.advanceTimersByTimeAsync(100);
		controller.cancel("switch");
		await vi.advanceTimersByTimeAsync(1000);
		await expect(done).resolves.toBeUndefined();
		expect(pi.aborts).toBe(1);
	});

	it("Session shutdown: the wait ends without touching the stale context", async () => {
		const { controller, pi } = setup({ baseDelayMs: 60_000 });
		const done = controller.beforeSettle(settleEvent(failure(RATE_LIMIT)), pi.env);
		await vi.advanceTimersByTimeAsync(100);
		const statuses = pi.statuses.length;
		const notes = pi.notes.length;
		expect(controller.cancel("shutdown")).toBe(true);
		await expect(done).resolves.toBeUndefined();
		expect(Date.now()).toBe(100);
		expect(pi.aborts).toBe(0);
		expect(pi.statuses).toHaveLength(statuses);
		expect(pi.notes).toHaveLength(notes);
	});

	it("/retry off cancels the wait", async () => {
		const { controller, pi } = setup({ baseDelayMs: 60_000 });
		const done = controller.beforeSettle(settleEvent(failure(RATE_LIMIT)), pi.env);
		await vi.advanceTimersByTimeAsync(100);
		controller.setEnabled(false);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(done).resolves.toBeUndefined();
		expect(pi.aborts).toBe(1);
	});

	it("cancel reports false when nothing waits", () => {
		const { controller } = setup();
		expect(controller.cancel("command")).toBe(false);
	});
});

describe("RetryController: records", () => {
	it("Abort from a non-terminal client: the record is corrected to cancelled", async () => {
		const { controller, pi } = setup();
		const result = await fail(controller, pi);
		const record = result?.entries?.[1];
		controller.settled(true);
		expect(pi.records).toEqual([
			{ ...(record?.type === "custom" ? (record.data as RetryRecord) : {}), outcome: "cancelled" },
		]);
	});

	it("keeps the record once the retried request has started", async () => {
		const { controller, pi } = setup();
		await fail(controller, pi);
		controller.messageEnd(assistant("aborted"), pi.env.gateSettings);
		controller.settled(true);
		expect(pi.records).toEqual([]);
	});

	it("keeps the record when the run settles normally", async () => {
		const { controller, pi } = setup();
		await fail(controller, pi);
		controller.settled(false);
		controller.settled(true);
		expect(pi.records).toEqual([]);
	});
});
