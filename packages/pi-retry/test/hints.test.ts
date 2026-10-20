import { describe, expect, it } from "vitest";
import { acceptHint, diagnosticHint, extractHint, headerHint, parseDuration, textHint } from "../src/hints.ts";

const NOW = Date.UTC(2026, 9, 21, 7, 27, 30);
const EPOCH_NOW = 1_760_000_040_000;

describe("parseDuration", () => {
	it.each([
		["1.5s", 1500],
		["6m0s", 360_000],
		["250ms", 250],
		["1h2m3s", 3_723_000],
		["12 minutes", 720_000],
		["12 min", 720_000],
		["2 hours", 7_200_000],
		["30 seconds", 30_000],
		["1 second", 1000],
	])("%s → %i ms", (text, ms) => {
		expect(parseDuration(text)).toBe(ms);
	});

	it.each(["soon", "", "12", "5 parsecs", "1.5x"])("rejects %j", (text) => {
		expect(parseDuration(text)).toBeUndefined();
	});
});

describe("headerHint", () => {
	it("Precedence: retry-after-ms, retry-after, OpenAI resets, anthropic resets, x-ratelimit-reset, ratelimit-reset", () => {
		const all = {
			"retry-after-ms": "1500",
			"retry-after": "20",
			"x-ratelimit-reset-requests": "6m0s",
			"x-ratelimit-reset-tokens": "1s",
			"anthropic-ratelimit-requests-reset": "2026-10-21T07:28:00Z",
			"x-ratelimit-reset": "40",
			"ratelimit-reset": "50",
		};
		const order: [string, number, string][] = [
			["retry-after-ms", 1500, "header retry-after-ms"],
			["retry-after", 20_000, "header retry-after"],
			["x-ratelimit-reset-requests", 360_000, "header x-ratelimit-reset-requests"],
			["x-ratelimit-reset-tokens", 1000, "header x-ratelimit-reset-tokens"],
			["anthropic-ratelimit-requests-reset", 30_000, "header anthropic-ratelimit-reset"],
			["x-ratelimit-reset", 40_000, "header x-ratelimit-reset"],
			["ratelimit-reset", 50_000, "header ratelimit-reset"],
		];
		const headers: Record<string, string> = { ...all };
		for (const [name, delayMs, source] of order) {
			expect(headerHint(headers, 429, NOW)).toEqual({ delayMs, source });
			delete headers[name];
		}
		expect(headerHint(headers, 429, NOW)).toBeUndefined();
	});

	it("matches header names case-insensitively", () => {
		expect(headerHint({ "Retry-After": "20" }, 503, NOW)).toEqual({ delayMs: 20_000, source: "header retry-after" });
	});

	it("Window-reset header on a non-429", () => {
		expect(headerHint({ "x-ratelimit-reset-requests": "6m0s" }, 503, NOW)).toBeUndefined();
		expect(headerHint({ "ratelimit-reset": "30" }, 500, NOW)).toBeUndefined();
	});

	it("Retry-After seconds", () => {
		expect(headerHint({ "retry-after": "20" }, 429, NOW)).toEqual({ delayMs: 20_000, source: "header retry-after" });
	});

	it("Retry-After date", () => {
		expect(headerHint({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, 429, NOW)?.delayMs).toBe(30_000);
	});

	it("OpenAI reset duration", () => {
		expect(headerHint({ "x-ratelimit-reset-requests": "6m0s" }, 429, NOW)?.delayMs).toBe(360_000);
	});

	it("Epoch reset", () => {
		expect(headerHint({ "x-ratelimit-reset": "1760000100" }, 429, EPOCH_NOW)?.delayMs).toBe(60_000);
		expect(headerHint({ "ratelimit-reset": "1760000100000" }, 429, EPOCH_NOW)?.delayMs).toBe(60_000);
	});

	it("anthropic reset timestamps: the latest wins", () => {
		const headers = {
			"anthropic-ratelimit-requests-reset": "2026-10-21T07:28:00Z",
			"anthropic-ratelimit-tokens-reset": "2026-10-21T07:29:30Z",
			"anthropic-ratelimit-input-tokens-reset": "2026-10-21T07:27:40Z",
		};
		expect(headerHint(headers, 429, NOW)).toEqual({ delayMs: 120_000, source: "header anthropic-ratelimit-reset" });
	});

	it("Reset in the past", () => {
		expect(headerHint({ "retry-after": "Wed, 21 Oct 2026 07:27:20 GMT" }, 429, NOW)).toBeUndefined();
		expect(headerHint({ "anthropic-ratelimit-tokens-reset": "2026-10-21T07:27:00Z" }, 429, NOW)).toBeUndefined();
	});

	it.each(["soon", "0", "-5", ""])("Garbage value: retry-after %j", (value) => {
		expect(headerHint({ "retry-after": value }, 429, NOW)).toBeUndefined();
	});

	it("falls through an unusable header to the next one", () => {
		expect(headerHint({ "retry-after": "soon", "x-ratelimit-reset-tokens": "2s" }, 429, NOW)?.delayMs).toBe(2000);
	});
});

describe("diagnosticHint", () => {
	it("Diagnostic delay", () => {
		const hint = diagnosticHint([{ type: "x", timestamp: 0, details: { status: 429, retryAfter: "15" } }], NOW);
		expect(hint).toEqual({ delayMs: 15_000, source: "diagnostic retryAfter" });
	});

	it("reads retryAfterMs and a retryDelay duration", () => {
		expect(diagnosticHint([{ type: "x", timestamp: 0, details: { retryAfterMs: 1200 } }], NOW)).toEqual({
			delayMs: 1200,
			source: "diagnostic retryAfterMs",
		});
		expect(diagnosticHint([{ type: "x", timestamp: 0, details: { retryDelay: "28s" } }], NOW)?.delayMs).toBe(28_000);
	});

	it("ignores diagnostics without delays", () => {
		expect(
			diagnosticHint(
				[
					{ type: "x", timestamp: 0 },
					{ type: "y", timestamp: 0, details: {} },
				],
				NOW,
			),
		).toBeUndefined();
	});
});

describe("textHint", () => {
	it.each([
		["Please try again in 1.2s.", 1200, "text try again in"],
		["try again in 6m0s", 360_000, "text try again in"],
		["try again in 250ms", 250, "text try again in"],
		['"retryDelay": "28s"', 28_000, "text retryDelay"],
		["retryDelay: 28s", 28_000, "text retryDelay"],
		["Server requested 90s retry delay", 90_000, "text server requested"],
		["You have hit your ChatGPT usage limit (plus plan). Try again in ~12 min.", 720_000, "text try again in"],
		["Try again in ~12 min", 720_000, "text try again in"],
		["please retry after 30 seconds", 30_000, "text retry after"],
		["retry-after: 30", 30_000, "text retry after"],
		["your limit resets in 5 minutes", 300_000, "text resets in"],
		["limit resets at 2026-10-21T07:28:00Z", 30_000, "text resets at"],
		["Try again in 12 minutes.", 720_000, "text try again in"],
	])("Recognised forms: %s", (text, delayMs, source) => {
		expect(textHint(text, NOW)).toEqual({ delayMs, source });
	});

	it("resets at an epoch, and a resets_at JSON field", () => {
		expect(textHint("resets at 1760000100", EPOCH_NOW)).toEqual({ delayMs: 60_000, source: "text resets at" });
		expect(textHint('{"resets_at": 1760000100}', EPOCH_NOW)).toEqual({ delayMs: 60_000, source: "text resets_at" });
		expect(textHint('{"reset_at":1760000100000}', EPOCH_NOW)?.delayMs).toBe(60_000);
	});

	it("OpenAI message", () => {
		expect(textHint("Rate limit reached for gpt-4o ... Please try again in 1.284s.", NOW)).toEqual({
			delayMs: 1284,
			source: "text try again in",
		});
	});

	it("Google RetryInfo", () => {
		const text = '{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"28s"}';
		expect(textHint(text, NOW)?.delayMs).toBe(28_000);
	});

	it("Codex usage-limit message", () => {
		const text = "You have hit your ChatGPT usage limit (plus plan). Try again in ~12 min.";
		expect(textHint(text, NOW)).toEqual({ delayMs: 720_000, source: "text try again in" });
	});

	it("Codex usage-limit rounded to zero", () => {
		expect(textHint("You have hit your ChatGPT usage limit (plus plan). Try again in ~0 min.", NOW)).toBeUndefined();
	});

	it("Codex usage-limit above the limit is still extracted", () => {
		const hint = textHint("You have hit your ChatGPT usage limit (pro plan). Try again in ~180 min.", NOW);
		expect(hint?.delayMs).toBe(10_800_000);
		expect(hint && acceptHint(hint, 1_800_000)).toEqual({
			accepted: false,
			reason: "provider asked to wait 3h, limit is 30m",
		});
	});

	it("Pi provider-retry cap message", () => {
		expect(textHint("Server requested 90s retry delay (max: 60s). 429 rate_limit_error", NOW)?.delayMs).toBe(90_000);
	});

	it("Reset timestamp", () => {
		expect(textHint('"resets_at": 1760000100', EPOCH_NOW)?.delayMs).toBe(60_000);
	});

	it.each([
		"usage limit reached; retry after 2 days",
		"retry after 3 attempts",
		"retry-after: 1e3",
		"Overloaded (retry-after: 2026-10-21T07:28:00Z)",
	])("takes no unsupported unit or longer value for bare seconds: %s", (text) => {
		expect(textHint(text, NOW)).toBeUndefined();
	});

	it("reads bare seconds at the end of a sentence", () => {
		expect(textHint("Please retry after 30.", NOW)?.delayMs).toBe(30_000);
		expect(textHint("retry after 1.5", NOW)?.delayMs).toBe(1500);
	});

	it("ignores text without a hint", () => {
		expect(textHint("429 rate limited", NOW)).toBeUndefined();
	});
});

describe("extractHint", () => {
	const text = "Please try again in 3s";
	const diagnostics = [{ type: "x", timestamp: 0, details: { retryAfter: "15" } }];

	it("ranks headers before diagnostics before text", () => {
		const capture = { status: 429, headers: { "retry-after": "20" } };
		expect(extractHint({ capture, diagnostics, text, now: NOW })?.source).toBe("header retry-after");
		expect(extractHint({ diagnostics, text, now: NOW })?.source).toBe("diagnostic retryAfter");
		expect(extractHint({ text, now: NOW })?.source).toBe("text try again in");
	});

	it("falls back when the headers carry no hint", () => {
		const capture = { status: 503, headers: { "x-ratelimit-reset-requests": "6m0s" } };
		expect(extractHint({ capture, text, now: NOW })?.source).toBe("text try again in");
	});
});

describe("acceptHint", () => {
	it("Hint inside the limit", () => {
		expect(acceptHint({ delayMs: 90_000, source: "x" }, 1_800_000)).toEqual({ accepted: true, delayMs: 90_250 });
	});

	it("Hint above the limit", () => {
		expect(acceptHint({ delayMs: 7_200_000, source: "x" }, 1_800_000)).toEqual({
			accepted: false,
			reason: "provider asked to wait 2h, limit is 30m",
		});
	});

	it("accepts a hint exactly at the limit", () => {
		expect(acceptHint({ delayMs: 1_800_000, source: "x" }, 1_800_000).accepted).toBe(true);
	});

	it("Limit disabled", () => {
		expect(acceptHint({ delayMs: 86_400_000 * 7, source: "x" }, 0)).toEqual({ accepted: true, delayMs: 604_800_250 });
	});
});
