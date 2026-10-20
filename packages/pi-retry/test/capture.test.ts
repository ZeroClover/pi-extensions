import { describe, expect, it } from "vitest";
import { type GateSettings, HeaderCapture } from "../src/capture.ts";
import { classify } from "../src/classify.ts";
import { assistant } from "./fixtures.ts";

const OPEN: GateSettings = { cacheWarming: "off", providerMaxRetries: 0 };
const MISTRAL = "mistral-conversations";

function windowWith(capture: HeaderCapture, settings: GateSettings, api: string, ...statuses: number[]): void {
	capture.requestStart();
	for (const status of statuses) capture.response({ status, headers: { "retry-after": "45" } });
	capture.requestEnd(settings, api);
}

describe("HeaderCapture gate", () => {
	it("Gate open", () => {
		const capture = new HeaderCapture();
		expect(capture.gate(OPEN)).toEqual({ open: true });
		windowWith(capture, OPEN, MISTRAL, 429);
		const taken = capture.take();
		expect(taken?.status).toBe(429);
		const message = assistant("error", "429 Too Many Requests", { api: MISTRAL, provider: "mistral" });
		const result = classify(
			{ message, capture: taken },
			{ patterns: { retryable: [], nonRetryable: [] }, maxRetryAfterMs: 1_800_000, now: 0 },
		);
		expect(result.hint).toEqual({ delayMs: 45_000, source: "header retry-after" });
	});

	it("treats an unset provider retry count as Pi's default of 0", () => {
		expect(new HeaderCapture().gate({ cacheWarming: "off" })).toEqual({ open: true });
	});

	it.each([
		[{ cacheWarming: "streaming", providerMaxRetries: 0 }],
		[{ cacheWarming: undefined, providerMaxRetries: 0 }],
		[{ cacheWarming: "idle", providerMaxRetries: 0 }],
	])("Warming enabled: %j", (settings) => {
		const capture = new HeaderCapture();
		expect(capture.gate(settings).open).toBe(false);
		windowWith(capture, settings, MISTRAL, 429);
		expect(capture.take()).toBeUndefined();
	});

	it("Warming enabled: a cache_warming_decision closes the gate for the rest of the session", () => {
		const capture = new HeaderCapture();
		capture.warmingDecision();
		expect(capture.gate(OPEN)).toEqual({ open: false, reason: "a cache-warming request ran in this session" });
		windowWith(capture, OPEN, MISTRAL, 429);
		expect(capture.take()).toBeUndefined();
		capture.reset();
		expect(capture.gate(OPEN).open).toBe(true);
	});

	it("Provider-level retries enabled", () => {
		const settings = { cacheWarming: "off", providerMaxRetries: 2 };
		const capture = new HeaderCapture();
		expect(capture.gate(settings)).toEqual({ open: false, reason: "retry.provider.maxRetries is not 0" });
		windowWith(capture, settings, MISTRAL, 429, 200);
		expect(capture.take()).toBeUndefined();
		// The closed gate is a setting, not evidence: it reopens when the setting changes.
		expect(capture.gate(OPEN).open).toBe(true);
	});

	it("Codex adapter", () => {
		const capture = new HeaderCapture();
		expect(capture.gateFor(OPEN, "openai-codex-responses").open).toBe(false);
		windowWith(capture, OPEN, "openai-codex-responses", 429);
		expect(capture.take()).toBeUndefined();
		expect(capture.gate(OPEN).open).toBe(true);
	});
});

describe("HeaderCapture window", () => {
	it("Single error capture", () => {
		const capture = new HeaderCapture();
		capture.requestStart();
		capture.response({ status: 503, headers: { "retry-after": "10" } });
		capture.requestEnd(OPEN, MISTRAL);
		expect(capture.take()).toEqual({ status: 503, headers: { "retry-after": "10" } });
		expect(capture.take()).toBeUndefined();
	});

	it("Stale capture", () => {
		const capture = new HeaderCapture();
		windowWith(capture, OPEN, MISTRAL, 429);
		// The next request fails before any response arrives.
		capture.requestStart();
		capture.requestEnd(OPEN, MISTRAL);
		expect(capture.take()).toBeUndefined();
	});

	it("ignores responses outside a window", () => {
		const capture = new HeaderCapture();
		capture.response({ status: 429, headers: {} });
		capture.requestEnd(OPEN, MISTRAL);
		expect(capture.take()).toBeUndefined();
	});

	it("a capture below 400 yields nothing (mid-stream failure after a 200)", () => {
		const capture = new HeaderCapture();
		windowWith(capture, OPEN, MISTRAL, 200);
		expect(capture.take()).toBeUndefined();
		expect(capture.gate(OPEN).open).toBe(true);
	});

	it("Unexpected second capture", () => {
		const capture = new HeaderCapture();
		windowWith(capture, OPEN, MISTRAL, 429, 429);
		expect(capture.take()).toBeUndefined();
		expect(capture.gate(OPEN)).toEqual({ open: false, reason: "several responses arrived for one request" });
		windowWith(capture, OPEN, MISTRAL, 429);
		expect(capture.take()).toBeUndefined();
	});

	it("binds by window, not by message object: distinct start and final messages", () => {
		// Pi hands message_start a shallow copy and message_end the final object; only the window matters.
		const start = assistant("error", "429");
		const final = { ...start };
		expect(final).not.toBe(start);
		for (const preStream of [true, false]) {
			const capture = new HeaderCapture();
			capture.requestStart();
			capture.response({ status: preStream ? 429 : 200, headers: { "retry-after": "5" } });
			capture.requestEnd(OPEN, final.api);
			expect(capture.take()?.status).toBe(preStream ? 429 : undefined);
		}
	});
});
