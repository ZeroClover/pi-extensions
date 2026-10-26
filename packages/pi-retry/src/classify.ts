import { type AssistantMessage, type AssistantMessageDiagnostic, isContextOverflow } from "@earendil-works/pi-ai";
import type { RetryPatterns } from "./config.ts";
import { formatDuration } from "./format.ts";
import { acceptHint, extractHint, type Hint } from "./hints.ts";
import {
	type Category,
	CODEX_NO_RESET_RULE,
	DETERMINISTIC_RULES,
	isDeterministic,
	isMappedStatus,
	SPECIFIC_STATUSES,
	TRANSIENT_RULES,
} from "./vocabulary.ts";

/** An HTTP response observed through `after_provider_response`. */
export interface Capture {
	status: number;
	headers: Readonly<Record<string, string>>;
}

export interface FailureInput {
	/** The failed assistant message: its error text, provider and diagnostics. */
	message: AssistantMessage;
	/** The failed request's error response, when the capture gate attributed one to it. */
	capture?: Capture | undefined;
}

export interface ClassifyOptions {
	patterns: RetryPatterns;
	maxRetryAfterMs: number;
	now: number;
}

export interface Classification {
	category: Category;
	retryable: boolean;
	/** Short human-readable explanation naming the evidence, used in notifications and session records. */
	reason: string;
	/** The recognised HTTP status, from the capture, diagnostics or text. */
	status?: number;
	/** The accepted provider hint; present only when the failure is retryable on it. */
	hint?: Hint;
}

/**
 * A three-digit code in a status position: at the start, or after `status`, `HTTP`, `code` or `(`. Other numbers
 * (token counts, ports, timestamps, millisecond fields) never count.
 */
const STATUS_IN_TEXT =
	/(?:^|\bstatus(?:[ _]?code)?["']?\s*[:=]?\s*|\bHTTP(?:\/\d(?:\.\d)?)?\s*:?\s*|\bcode["']?\s*[:=]?\s*|\()(\d{3})(?!\d|\.\d|[a-z])/gi;

/** LiteLLM's gateway-envelope rule: a 5xx whose body carries a 429 is a rate limit. */
const WRAPPED_429 = /"code"\s*:\s*429(?!\d)|RESOURCE_EXHAUSTED/;

const OVERRIDING_STATUSES_FOR_INVALID_REQUEST = new Set([408, 409, 429]);

function statusFromText(text: string): number | undefined {
	for (const match of text.matchAll(STATUS_IN_TEXT)) {
		const status = Number(match[1]);
		if (isMappedStatus(status)) return status;
	}
	return undefined;
}

function statusFromDiagnostics(diagnostics: readonly AssistantMessageDiagnostic[]): number | undefined {
	for (const diagnostic of diagnostics) {
		const { status } = diagnostic.details ?? {};
		if (typeof status === "number" && isMappedStatus(status)) return status;
	}
	return undefined;
}

/** The status the classifier works with: captured (errors only), then diagnostics, then the guarded text match. */
export function recogniseStatus(
	text: string,
	diagnostics: readonly AssistantMessageDiagnostic[],
	capture: Capture | undefined,
): number | undefined {
	const status =
		(capture && capture.status >= 400 ? capture.status : undefined) ??
		statusFromDiagnostics(diagnostics) ??
		statusFromText(text);
	if (status !== undefined && status >= 500 && status <= 599 && WRAPPED_429.test(text)) return 429;
	return status;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/**
 * Diagnostic codes and types that Pi may leave out of the rendered text: Bedrock's `details.errorCode`, pi-messages'
 * parsed `details.error.code` / `details.error.type`, and the thrown exception's `error.code`.
 */
export function diagnosticValues(diagnostics: readonly AssistantMessageDiagnostic[]): string[] {
	const values: (string | undefined)[] = [];
	for (const diagnostic of diagnostics) {
		const { errorCode, error } = diagnostic.details ?? {};
		values.push(stringValue(errorCode));
		if (isRecord(error)) {
			const { code, type } = error;
			values.push(stringValue(code), stringValue(type));
		}
		values.push(stringValue(diagnostic.error?.code));
	}
	return values.filter((value): value is string => value !== undefined && value !== "");
}

interface Evidence {
	category: Category;
	evidence: string;
}

function firstMatch<C extends Category>(
	rules: readonly { pattern: RegExp; category: C }[],
	text: string,
	skip: (category: C) => boolean,
): Evidence | undefined {
	for (const rule of rules) {
		if (skip(rule.category)) continue;
		const match = rule.pattern.exec(text);
		if (match) return { category: rule.category, evidence: match[0] };
	}
	return undefined;
}

function categorise(message: AssistantMessage, text: string, status: number | undefined): Evidence {
	const throttled =
		status === 429 ||
		status === 529 ||
		TRANSIENT_RULES.some(
			(rule) => (rule.category === "rate_limit" || rule.category === "overloaded") && rule.pattern.test(text),
		);
	// Pi's overflow patterns include `too many tokens`, which throttling messages also use.
	if (!throttled && isContextOverflow(message))
		return { category: "context_overflow", evidence: "Pi's overflow patterns" };

	// Matched on the error text alone: diagnostic codes joined to `text` would break its anchor.
	const codex = CODEX_NO_RESET_RULE.pattern.exec(message.errorMessage ?? "");
	if (codex) return { category: CODEX_NO_RESET_RULE.category, evidence: codex[0] };

	const isServerStatus = status !== undefined && status >= 500 && status <= 599;
	const discardInvalidRequest =
		isServerStatus || (status !== undefined && OVERRIDING_STATUSES_FOR_INVALID_REQUEST.has(status));
	const deterministic = firstMatch(
		DETERMINISTIC_RULES,
		text,
		(category) =>
			(category === "invalid_request" && discardInvalidRequest) || (category === "context_overflow" && throttled),
	);
	if (deterministic) return deterministic;

	const specific = status === undefined ? undefined : SPECIFIC_STATUSES[status];
	if (status !== undefined && specific) return { category: specific, evidence: `HTTP ${status}` };

	const transient = firstMatch(TRANSIENT_RULES, text, () => false);
	if (transient) return transient;

	if (status !== undefined && isServerStatus) return { category: "server_error", evidence: `HTTP ${status}` };
	return { category: "unknown", evidence: "no known pattern" };
}

/** Classifies a failed model request and resolves its retry decision. */
export function classify(input: FailureInput, options: ClassifyOptions): Classification {
	const { message, capture } = input;
	const text = message.errorMessage ?? "";
	const diagnostics = message.diagnostics ?? [];
	const status = recogniseStatus(text, diagnostics, capture);
	const wordText = [text, ...diagnosticValues(diagnostics)].join("\n");
	const { category, evidence } = categorise(message, wordText, status);
	const base = `${category}: ${evidence}`;
	const withStatus = status === undefined ? {} : { status };

	const nonRetryable = options.patterns.nonRetryable.find((pattern) => pattern.test(wordText));
	const retryable = options.patterns.retryable.find((pattern) => pattern.test(wordText));
	const found = extractHint({
		capture: capture && capture.status >= 400 ? capture : undefined,
		diagnostics,
		text,
		now: options.now,
	});
	const verdict = found && acceptHint(found, options.maxRetryAfterMs);

	if (verdict && !verdict.accepted) return { category, retryable: false, reason: verdict.reason, ...withStatus };
	const accepted = found && verdict?.accepted ? { hint: found } : {};
	const hinted = found ? `${base}; provider asked to wait ${formatDuration(found.delayMs)} (${found.source})` : base;

	if (nonRetryable) {
		return {
			category,
			retryable: false,
			reason: `${base}; matches nonRetryable pattern ${nonRetryable}`,
			...withStatus,
		};
	}
	if (retryable) {
		return {
			category,
			retryable: true,
			reason: `${hinted}; matches retryable pattern ${retryable}`,
			...withStatus,
			...accepted,
		};
	}
	if (category === "quota") {
		return found
			? { category, retryable: true, reason: hinted, ...withStatus, ...accepted }
			: { category, retryable: false, reason: "quota or billing limit without a reset time", ...withStatus };
	}
	if (isDeterministic(category)) return { category, retryable: false, reason: base, ...withStatus };
	return { category, retryable: true, reason: hinted, ...withStatus, ...accepted };
}
