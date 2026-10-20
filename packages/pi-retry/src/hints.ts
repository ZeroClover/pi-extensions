import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import { formatDuration } from "./format.ts";

/** A wait the provider asked for, in milliseconds from the moment of extraction. */
export interface Hint {
	delayMs: number;
	source: string;
}

/** Added to every honoured hint so the retry lands after the provider's deadline, not on it. */
export const HINT_GRACE_MS = 250;

const UNIT_MS: Readonly<Record<string, number>> = {
	ms: 1,
	millisecond: 1,
	milliseconds: 1,
	s: 1000,
	sec: 1000,
	secs: 1000,
	second: 1000,
	seconds: 1000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
};

/**
 * A duration as providers write it: compact Go-style segments (`1.5s`, `6m0s`, `250ms`, `1h2m`) or a number and a
 * unit word (`12 minutes`, `~12 min`, `30 seconds`).
 */
const DURATION = String.raw`(?:\d+(?:\.\d+)?(?:ms|h|m|s))+(?![a-z])|\d+(?:\.\d+)?\s*(?:milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?)\b`;
const COMPACT_SEGMENT = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
const WORD_DURATION = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i;

/** Parses a duration written by a provider into milliseconds; undefined when it is not one. */
export function parseDuration(text: string): number | undefined {
	const trimmed = text.trim();
	if (new RegExp(`^(?:${DURATION})$`, "i").test(trimmed)) {
		const word = WORD_DURATION.exec(trimmed);
		const unit = word?.[2] && UNIT_MS[word[2].toLowerCase()];
		if (word?.[1] && unit) return Number(word[1]) * unit;
		let total = 0;
		for (const [, amount, segment] of trimmed.toLowerCase().matchAll(COMPACT_SEGMENT)) {
			total += Number(amount) * (UNIT_MS[segment ?? ""] ?? 0);
		}
		return total;
	}
	return undefined;
}

/** A number that is an epoch in milliseconds (above 10^12) or seconds (above 10^9), else a duration in seconds. */
function epochOrSeconds(value: number, now: number): number {
	if (value > 1e12) return value - now;
	if (value > 1e9) return value * 1000 - now;
	return value * 1000;
}

const NUMBER = /^\d+(?:\.\d+)?$/;

/** `retry-after` semantics: seconds, or an HTTP-date. */
function parseRetryAfter(value: string, now: number): number | undefined {
	const trimmed = value.trim();
	if (NUMBER.test(trimmed)) return Number(trimmed) * 1000;
	// HTTP-dates name a weekday; a bare number or word must not reach Date.parse, which accepts too much.
	if (!/^[a-z]{3},/i.test(trimmed)) return undefined;
	const time = Date.parse(trimmed);
	return Number.isNaN(time) ? undefined : time - now;
}

/** Seconds, or an epoch in seconds or milliseconds (`x-ratelimit-reset`, `ratelimit-reset`). */
function parseReset(value: string, now: number): number | undefined {
	const trimmed = value.trim();
	return NUMBER.test(trimmed) ? epochOrSeconds(Number(trimmed), now) : undefined;
}

/** An RFC 3339 / ISO 8601 timestamp. */
function parseTimestamp(value: string, now: number): number | undefined {
	const trimmed = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return undefined;
	const time = Date.parse(trimmed);
	return Number.isNaN(time) ? undefined : time - now;
}

/** A positive, finite delay; everything else (past times, zero, garbage) is no hint. */
function usable(delayMs: number | undefined): delayMs is number {
	return delayMs !== undefined && Number.isFinite(delayMs) && delayMs > 0;
}

function hint(delayMs: number | undefined, source: string): Hint | undefined {
	return usable(delayMs) ? { delayMs: Math.round(delayMs), source } : undefined;
}

/**
 * Reads a hint from response headers. `retry-after-ms` and `retry-after` apply to every error status; the
 * window-reset headers describe quota windows and apply only to a 429.
 */
export function headerHint(headers: Readonly<Record<string, string>>, status: number, now: number): Hint | undefined {
	const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	const read = (name: string): string | undefined => lower.get(name);

	const ms = read("retry-after-ms");
	const fromMs =
		ms !== undefined && NUMBER.test(ms.trim()) ? hint(Number(ms.trim()), "header retry-after-ms") : undefined;
	if (fromMs) return fromMs;
	const retryAfter = read("retry-after");
	const fromRetryAfter =
		retryAfter === undefined ? undefined : hint(parseRetryAfter(retryAfter, now), "header retry-after");
	if (fromRetryAfter) return fromRetryAfter;
	if (status !== 429) return undefined;

	for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
		const value = read(name);
		const found = value === undefined ? undefined : hint(parseDuration(value), `header ${name}`);
		if (found) return found;
	}
	const anthropic = [...lower]
		.filter(([name]) => /^anthropic-ratelimit-[a-z-]+-reset$/.test(name))
		.map(([, value]) => parseTimestamp(value, now))
		.filter(usable);
	if (anthropic.length > 0) return hint(Math.max(...anthropic), "header anthropic-ratelimit-reset");
	for (const name of ["x-ratelimit-reset", "ratelimit-reset"]) {
		const value = read(name);
		const found = value === undefined ? undefined : hint(parseReset(value, now), `header ${name}`);
		if (found) return found;
	}
	return undefined;
}

/** Reads `retryAfterMs`, `retryAfter` or `retryDelay` from diagnostic details, with the matching header's units. */
export function diagnosticHint(diagnostics: readonly AssistantMessageDiagnostic[], now: number): Hint | undefined {
	for (const diagnostic of diagnostics) {
		const details = diagnostic.details;
		if (!details) continue;
		const { retryAfterMs, retryAfter, retryDelay } = details;
		const candidates: [unknown, (value: string) => number | undefined, string][] = [
			[retryAfterMs, (value) => (NUMBER.test(value) ? Number(value) : undefined), "diagnostic retryAfterMs"],
			[retryAfter, (value) => parseRetryAfter(value, now), "diagnostic retryAfter"],
			[
				retryDelay,
				(value) => (NUMBER.test(value) ? Number(value) * 1000 : parseDuration(value)),
				"diagnostic retryDelay",
			],
		];
		for (const [value, parse, source] of candidates) {
			if (typeof value !== "string" && typeof value !== "number") continue;
			const found = hint(parse(String(value).trim()), source);
			if (found) return found;
		}
	}
	return undefined;
}

interface TextForm {
	pattern: RegExp;
	source: string;
	parse: (match: string, now: number) => number | undefined;
}

/** Text forms in precedence order; the first that yields a usable delay wins. */
const TEXT_FORMS: readonly TextForm[] = [
	// OpenAI `try again in 1.284s` / `6m0s` / `250ms`, Pi's Codex adapter `Try again in ~12 min.`, ChatGPT `12 minutes`.
	{
		pattern: new RegExp(`try again in\\s*~?\\s*(${DURATION})`, "i"),
		source: "text try again in",
		parse: parseDuration,
	},
	// Google RetryInfo, as JSON or as rendered text.
	{
		pattern: /retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?s)\b/i,
		source: "text retryDelay",
		parse: parseDuration,
	},
	// Pi's provider-level retry when the requested delay exceeds its cap (seconds, rounded up by Pi).
	{
		pattern: /server requested (\d+(?:\.\d+)?)s retry delay/i,
		source: "text server requested",
		parse: (value) => Number(value) * 1000,
	},
	{
		// A bare number is seconds only when nothing extends it: `2 days`, `3 attempts`, `1e3` or a date are no hint.
		pattern: new RegExp(`retry[- ]after\\s*:?\\s*(${DURATION}|\\d+(?:\\.\\d+)?(?!\\.?\\d|[:-]|[ \\t]*[a-z]))`, "i"),
		source: "text retry after",
		parse: (value) => (NUMBER.test(value) ? Number(value) * 1000 : parseDuration(value)),
	},
	{ pattern: new RegExp(`resets? in\\s*~?\\s*(${DURATION})`, "i"), source: "text resets in", parse: parseDuration },
	{
		pattern: /resets? at\s*:?\s*(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?|\d{10,13})/i,
		source: "text resets at",
		parse: (value, now) => (NUMBER.test(value) ? epochOrSeconds(Number(value), now) : parseTimestamp(value, now)),
	},
	{
		pattern: /"?resets?_at"?\s*:\s*"?(\d{10,13})\b/i,
		source: "text resets_at",
		parse: (value, now) => epochOrSeconds(Number(value), now),
	},
];

/** Reads a hint from the error text. */
export function textHint(text: string, now: number): Hint | undefined {
	for (const form of TEXT_FORMS) {
		const value = form.pattern.exec(text)?.[1];
		const found = value === undefined ? undefined : hint(form.parse(value, now), form.source);
		if (found) return found;
	}
	return undefined;
}

export interface HintInput {
	/** Headers of the failed request's error response, with its status, when the capture gate allowed them. */
	capture?: { status: number; headers: Readonly<Record<string, string>> } | undefined;
	diagnostics?: readonly AssistantMessageDiagnostic[] | undefined;
	text: string;
	now: number;
}

/** Headers first, then diagnostics, then the error text. */
export function extractHint(input: HintInput): Hint | undefined {
	return (
		(input.capture && headerHint(input.capture.headers, input.capture.status, input.now)) ??
		(input.diagnostics && diagnosticHint(input.diagnostics, input.now)) ??
		textHint(input.text, input.now)
	);
}

export type HintVerdict = { accepted: true; delayMs: number } | { accepted: false; reason: string };

/** Compares a hint with `maxRetryAfterMs` (0 disables the limit); an accepted hint waits its value plus the grace. */
export function acceptHint(found: Hint, maxRetryAfterMs: number): HintVerdict {
	if (maxRetryAfterMs > 0 && found.delayMs > maxRetryAfterMs) {
		return {
			accepted: false,
			reason: `provider asked to wait ${formatDuration(found.delayMs)}, limit is ${formatDuration(maxRetryAfterMs)}`,
		};
	}
	return { accepted: true, delayMs: found.delayMs + HINT_GRACE_MS };
}
