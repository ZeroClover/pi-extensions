import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRY_USAGE, runRetryCommand } from "../src/command.ts";
import { defaultConfig } from "../src/config.ts";
import { RetryController, type SettleEnvironment } from "../src/controller.ts";
import { failure } from "./fixtures.ts";

const OPEN = { open: true } as const;

function controller(): RetryController {
	const config = defaultConfig();
	config.patterns.retryable.push(/backend saturated/i);
	return new RetryController(config, { appendRecord: () => {} });
}

const env: SettleEnvironment = {
	notify: () => {},
	setStatus: () => {},
	hasPendingMessages: () => false,
	abort: () => {},
	onTerminalInput: () => () => {},
	gateSettings: {},
	now: () => Date.now(),
	random: () => 1,
};

beforeEach(() => {
	vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("runRetryCommand", () => {
	it("Status while idle", () => {
		const result = runRetryCommand("", controller(), { open: false, reason: "cacheWarming is not off" }, 0);
		expect(result?.level).toBe("info");
		expect(result?.message.split("\n")).toEqual([
			"pi-retry",
			"  enabled: true",
			"  maxRetries: 10",
			"  baseDelayMs: 2000",
			"  maxBackoffMs: 60000",
			"  maxRetryAfterMs: 1800000",
			"  patterns: 1 retryable, 0 nonRetryable",
			"  headerHints: off (cacheWarming is not off)",
			"  state: idle",
		]);
	});

	it("shows headerHints: on when the gate is open", () => {
		expect(runRetryCommand("", controller(), OPEN, 0)?.message).toContain("  headerHints: on\n");
	});

	it("Status while waiting", async () => {
		const retry = controller();
		const failed = failure("429 Too Many Requests");
		const entry = {
			sourceEntry: { type: "message" as const, id: "a1", parentId: null, timestamp: "", message: failed },
			messages: [failed],
		};
		const done = retry.beforeSettle(
			{
				outcome: "error",
				continue: false,
				entries: [],
				context: {
					contextEntries: [entry],
					contextMessages: [failed],
					llmMessages: [],
					pendingMessages: [],
					canContinue: false,
				},
			},
			env,
		);
		await vi.advanceTimersByTimeAsync(500);
		const status = runRetryCommand("", retry, OPEN, Date.now())?.message ?? "";
		expect(status).toContain("  state: waiting, retry 1/10 in 2s: rate_limit: HTTP 429");

		expect(runRetryCommand("cancel", retry, OPEN, Date.now())).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1000);
		await expect(done).resolves.toBeUndefined();
	});

	it("shows why header hints are off for the Codex adapter", () => {
		const retry = controller();
		const gate = retry.capture.gateFor({ cacheWarming: "off" }, "openai-codex-responses");
		expect(runRetryCommand("", retry, gate, 0)?.message).toContain(
			"  headerHints: off (openai-codex-responses retries inside one request)\n",
		);
	});

	it("Cancel without a wait", () => {
		expect(runRetryCommand("cancel", controller(), OPEN, 0)).toEqual({
			message: "pi-retry: no retry is waiting",
			level: "info",
		});
	});

	it("Off then on", () => {
		const retry = controller();
		expect(runRetryCommand(" off ", retry, OPEN, 0)?.message).toBe("pi-retry: off for this session");
		expect(retry.enabled).toBe(false);
		expect(runRetryCommand("", retry, OPEN, 0)?.message).toContain(
			"enabled: false (changed by /retry for this session)",
		);
		expect(runRetryCommand("ON", retry, OPEN, 0)?.message).toBe("pi-retry: on for this session");
		expect(retry.enabled).toBe(true);
	});

	it("prints the usage for any other argument", () => {
		expect(runRetryCommand("now please", controller(), OPEN, 0)).toEqual({ message: RETRY_USAGE, level: "warning" });
	});
});
