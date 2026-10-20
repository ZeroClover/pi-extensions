import { type AssistantMessageDiagnostic, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type Capture, type Classification, classify, recogniseStatus } from "../src/classify.ts";
import type { RetryPatterns } from "../src/config.ts";
import { type Category, DETERMINISTIC_RULES, TRANSIENT_RULES } from "../src/vocabulary.ts";
import { assistant, failure } from "./fixtures.ts";

const NOW = Date.UTC(2026, 9, 21, 7, 27, 30);
const NO_PATTERNS: RetryPatterns = { retryable: [], nonRetryable: [] };
const QUOTA_REASON = "quota or billing limit without a reset time";

interface RunOptions {
	diagnostics?: AssistantMessageDiagnostic[];
	capture?: Capture;
	patterns?: Partial<Record<keyof RetryPatterns, string[]>>;
	maxRetryAfterMs?: number;
	provider?: string;
}

function run(text: string, options: RunOptions = {}): Classification {
	const message = options.provider
		? assistant("error", text, { provider: options.provider })
		: failure(text, options.diagnostics);
	const patterns: RetryPatterns = {
		retryable: (options.patterns?.retryable ?? []).map((source) => new RegExp(source, "i")),
		nonRetryable: (options.patterns?.nonRetryable ?? []).map((source) => new RegExp(source, "i")),
	};
	return classify(
		{ message, capture: options.capture },
		{
			patterns: options.patterns ? patterns : NO_PATTERNS,
			maxRetryAfterMs: options.maxRetryAfterMs ?? 1_800_000,
			now: NOW,
		},
	);
}

describe("vocabulary tables", () => {
	const rules = [...DETERMINISTIC_RULES, ...TRANSIENT_RULES];

	it("holds compiled, case-insensitive patterns, each in exactly one category", () => {
		const sources = rules.map((rule) => rule.pattern.source);
		expect(new Set(sources).size).toBe(sources.length);
		for (const rule of rules) {
			expect(rule.pattern).toBeInstanceOf(RegExp);
			expect(rule.pattern.flags).toBe("i");
		}
	});

	it("keeps deterministic and transient categories apart", () => {
		const deterministic = new Set<Category>(DETERMINISTIC_RULES.map((rule) => rule.category));
		const transient = new Set<Category>(TRANSIENT_RULES.map((rule) => rule.category));
		expect([...deterministic].filter((category) => transient.has(category))).toEqual([]);
		expect([...deterministic]).toEqual([
			"context_overflow",
			"auth",
			"not_found",
			"content_policy",
			"invalid_request",
			"quota",
		]);
		expect([...transient]).toEqual(["rate_limit", "overloaded", "timeout", "transport", "server_error"]);
	});
});

interface Row {
	text: string;
	category: Category;
	retryable: boolean;
	reason: string;
	hintMs?: number;
	diagnostics?: AssistantMessageDiagnostic[];
	provider?: string;
}

/** Real provider error strings (Pi's tests and adapters, LiteLLM's exception mapping, provider documentation). */
const REAL_ERRORS: Row[] = [
	// Anthropic
	{
		text: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit"}}',
		category: "rate_limit",
		retryable: true,
		reason: "rate_limit: HTTP 429",
	},
	{
		text: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		category: "overloaded",
		retryable: true,
		reason: "overloaded: HTTP 529",
	},
	{
		text: '500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
		category: "server_error",
		retryable: true,
		reason: "server_error: api_error",
	},
	{
		text: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		category: "auth",
		retryable: false,
		reason: "auth: authentication_error",
	},
	{
		text: '403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}',
		category: "auth",
		retryable: false,
		reason: "auth: permission_error",
	},
	{
		text: '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}',
		category: "not_found",
		retryable: false,
		reason: "not_found: not_found",
	},
	{
		text: '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: roles must alternate"}}',
		category: "invalid_request",
		retryable: false,
		reason: "invalid_request: invalid_request",
	},
	{
		text: '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
		category: "context_overflow",
		retryable: false,
		reason: "context_overflow: Pi's overflow patterns",
	},
	{
		text: "prompt is too long: 213462 tokens > 200000 maximum",
		category: "context_overflow",
		retryable: false,
		reason: "context_overflow: Pi's overflow patterns",
	},
	{
		text: "Anthropic stream ended before message_stop",
		category: "transport",
		retryable: true,
		reason: "transport: stream ended before",
	},
	// OpenAI
	{
		text: "429 Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 1.284s. Visit https://platform.openai.com/account/rate-limits to learn more.",
		category: "rate_limit",
		retryable: true,
		reason: "rate_limit: HTTP 429; provider asked to wait 1.3s (text try again in)",
		hintMs: 1284,
	},
	{
		text: "429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
		category: "quota",
		retryable: false,
		reason: QUOTA_REASON,
	},
	{
		text: "401 Incorrect API key provided: sk-abc. You can find your API key at https://platform.openai.com/account/api-keys.",
		category: "auth",
		retryable: false,
		reason: "auth: Incorrect API key",
	},
	{
		text: "404 The model `gpt-9` does not exist or you do not have access to it.",
		category: "not_found",
		retryable: false,
		reason: "not_found: does not exist or you do not have access",
	},
	{
		text: "400 This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
		category: "context_overflow",
		retryable: false,
		reason: "context_overflow: Pi's overflow patterns",
	},
	{
		text: "400 Your request was rejected as a result of our safety system. content_policy_violation",
		category: "content_policy",
		retryable: false,
		reason: "content_policy: content_policy",
	},
	{
		text: "500 The server had an error while processing your request. Sorry about that!",
		category: "server_error",
		retryable: true,
		reason: "server_error: HTTP 500",
	},
	{
		text: "503 The engine is currently overloaded, please try again later",
		category: "overloaded",
		retryable: true,
		reason: "overloaded: overloaded",
	},
	{
		text: "An error occurred while processing your request. You can retry your request, or contact us through our help center.",
		category: "server_error",
		retryable: true,
		reason: "server_error: You can retry your request",
	},
	// Google
	{
		text: '429 {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
		category: "rate_limit",
		retryable: true,
		reason: "rate_limit: HTTP 429",
	},
	{
		text: '400 {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
		category: "auth",
		retryable: false,
		reason: "auth: API key not valid",
	},
	{
		text: '403 {"error":{"code":403,"message":"Permission denied on resource project x.","status":"PERMISSION_DENIED"}}',
		category: "auth",
		retryable: false,
		reason: "auth: Permission denied",
	},
	{
		text: '504 {"error":{"code":504,"message":"Deadline expired before operation could complete.","status":"DEADLINE_EXCEEDED"}}',
		category: "timeout",
		retryable: true,
		reason: "timeout: HTTP 504",
	},
	{
		text: '429 {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"28s"}]}}',
		category: "quota",
		retryable: true,
		reason: "quota: exceeded your current quota; provider asked to wait 28s (text retryDelay)",
		hintMs: 28_000,
	},
	// Bedrock
	{
		text: "Throttling error: Too many tokens, please wait before trying again.",
		category: "rate_limit",
		retryable: true,
		reason: "rate_limit: Throttl",
	},
	{
		text: "Service unavailable: Bedrock is unable to process your request.",
		category: "server_error",
		retryable: true,
		reason: "server_error: Service unavailable",
	},
	{
		text: "Model stream error: The system encountered an unexpected error during processing. Try your request again.",
		category: "server_error",
		retryable: true,
		reason: "server_error: Model stream error",
	},
	{
		text: "Internal server error: An internal server error occurred.",
		category: "server_error",
		retryable: true,
		reason: "server_error: server error",
	},
	{
		text: "ModelTimeoutException: Model has timed out in processing the request",
		category: "timeout",
		retryable: true,
		reason: "timeout: Timeout",
	},
	{
		text: "AccessDeniedException: You don't have access to the model with the specified model ID.",
		category: "auth",
		retryable: false,
		reason: "auth: AccessDenied",
	},
	{
		text: "Validation error: The model returned the following errors: malformed input request",
		category: "invalid_request",
		retryable: false,
		reason: "invalid_request: Validation error",
		diagnostics: [
			{ type: "bedrock_response_failure", timestamp: 0, details: { status: 400, errorCode: "ValidationException" } },
		],
	},
	// Mistral, OpenRouter, Cerebras
	{
		text: 'Mistral API error (429): {"object":"error","message":"Requests rate limit exceeded","type":"rate_limited","code":"1300"}',
		category: "rate_limit",
		retryable: true,
		reason: "rate_limit: HTTP 429",
	},
	{
		text: "Provider returned error",
		category: "server_error",
		retryable: true,
		reason: "server_error: Provider returned error",
	},
	{
		text: '402 {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}',
		category: "quota",
		retryable: false,
		reason: QUOTA_REASON,
	},
	{
		text: "400 status code (no body)",
		category: "context_overflow",
		retryable: false,
		reason: "context_overflow: Pi's overflow patterns",
		provider: "cerebras",
	},
	// LiteLLM proxy
	{
		text: 'litellm.RateLimitError: AnthropicException - {"type":"error","error":{"type":"rate_limit_error"}}',
		category: "rate_limit",
		retryable: true,
		reason: "rate_limit: RateLimit",
	},
	{
		text: "litellm.BadRequestError: ContextWindowExceededError: maximum input exceeded",
		category: "context_overflow",
		retryable: false,
		reason: "context_overflow: ContextWindowExceeded",
	},
	{
		text: "litellm.BudgetExceededError: Budget has been exceeded! Current cost: 10.5, Max budget: 10.0",
		category: "quota",
		retryable: false,
		reason: QUOTA_REASON,
	},
	{
		text: "litellm.APIConnectionError: Connection error.",
		category: "transport",
		retryable: true,
		reason: "transport: ConnectionError",
	},
	{ text: "litellm.Timeout: Request timed out", category: "timeout", retryable: true, reason: "timeout: Timeout" },
	// Transport
	{ text: "fetch failed", category: "transport", retryable: true, reason: "transport: fetch failed" },
	{
		text: "request to https://api.example.com/v1 failed, reason: socket hang up",
		category: "transport",
		retryable: true,
		reason: "transport: socket hang up",
	},
	{
		text: "getaddrinfo ENOTFOUND api.anthropic.com",
		category: "transport",
		retryable: true,
		reason: "transport: getaddrinfo",
	},
	{ text: "read ECONNRESET", category: "transport", retryable: true, reason: "transport: ECONNRESET" },
	{ text: "terminated", category: "transport", retryable: true, reason: "transport: terminated" },
	{ text: "WebSocket closed 1006", category: "transport", retryable: true, reason: "transport: WebSocket closed" },
	// Codex and subscriptions
	{
		text: "You have hit your ChatGPT usage limit (plus plan). Try again in ~12 min.",
		category: "quota",
		retryable: true,
		reason: "quota: usage limit; provider asked to wait 12m (text try again in)",
		hintMs: 720_000,
	},
	{
		text: "You have hit your ChatGPT usage limit (plus plan). Try again in ~0 min.",
		category: "quota",
		retryable: false,
		reason: QUOTA_REASON,
	},
	{
		text: '429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached"}}',
		category: "quota",
		retryable: false,
		reason: QUOTA_REASON,
	},
	{
		text: "Server requested 90s retry delay (max: 60s). 429 rate_limit_error",
		category: "rate_limit",
		retryable: true,
		reason: "rate_limit: rate_limit; provider asked to wait 1m 30s (text server requested)",
		hintMs: 90_000,
	},
	// gRPC backends
	{ text: "ResourceExhausted: rate limit", category: "rate_limit", retryable: true, reason: "rate_limit: rate limit" },
	// Gateway wording added in Pi 1.3.0's retry list
	{
		text: "The service is temporarily unavailable",
		category: "server_error",
		retryable: true,
		reason: "server_error: service is temporarily unavailable",
	},
	{
		text: "The upstream provider returned an error",
		category: "server_error",
		retryable: true,
		reason: "server_error: provider returned an error",
	},
	{
		text: "unable to forward upstream response stream",
		category: "server_error",
		retryable: true,
		reason: "server_error: unable to forward upstream",
	},
];

describe("classify: real provider errors", () => {
	it("covers at least 40 strings", () => {
		expect(REAL_ERRORS.length).toBeGreaterThanOrEqual(40);
	});

	it.each(REAL_ERRORS)("$text", (row) => {
		const options: RunOptions = {};
		if (row.diagnostics) options.diagnostics = row.diagnostics;
		if (row.provider) options.provider = row.provider;
		const result = run(row.text, options);
		expect(result.category).toBe(row.category);
		expect(result.retryable).toBe(row.retryable);
		expect(result.reason.toLowerCase()).toBe(row.reason.toLowerCase());
		expect(result.hint?.delayMs).toBe(row.hintMs);
	});
});

describe("classify: inputs", () => {
	it("Error text only", () => {
		const result = run(
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit"}}',
		);
		expect(result).toMatchObject({ category: "rate_limit", retryable: true });
	});

	it("Diagnostic error code", () => {
		const result = run("Validation error: malformed input", {
			diagnostics: [{ type: "bedrock_response_failure", timestamp: 0, details: { errorCode: "ValidationException" } }],
		});
		expect(result).toMatchObject({ category: "invalid_request", retryable: false });
	});

	it("Diagnostic errorCode alone classifies a Bedrock exception", () => {
		const result = run("Bedrock request failed", {
			diagnostics: [{ type: "bedrock_response_failure", timestamp: 0, details: { errorCode: "ThrottlingException" } }],
		});
		expect(result).toMatchObject({ category: "rate_limit", retryable: true });
	});

	it("Deterministic type only in a nested diagnostic (pi-messages' emitted shape)", () => {
		const text = "429 Too Many Requests: slow down";
		const diagnostic: AssistantMessageDiagnostic = {
			type: "pi_messages_response_failure",
			timestamp: 1_760_000_000_000,
			error: { name: "PiMessagesResponseError", message: text, stack: `PiMessagesResponseError: ${text}` },
			details: {
				version: 1,
				provider: "pi",
				model: "pi-model",
				url: "https://api.example.com/v1/messages",
				status: 429,
				statusText: "Too Many Requests",
				error: { message: "slow down", type: "insufficient_quota" },
				timestampMs: 1_760_000_000_000,
			},
		};
		const result = run(text, { diagnostics: [diagnostic] });
		expect(result).toMatchObject({ category: "quota", retryable: false, status: 429, reason: QUOTA_REASON });
	});

	it("reads the thrown exception's error.code", () => {
		const result = run("request failed", {
			diagnostics: [
				{ type: "provider_transport_failure", timestamp: 0, error: { message: "x", code: "ECONNREFUSED" } },
			],
		});
		expect(result.category).toBe("transport");
	});

	it("ignores a capture below 400", () => {
		const result = run("stream broke", { capture: { status: 200, headers: { "retry-after": "5" } } });
		expect(result.status).toBeUndefined();
		expect(result.hint).toBeUndefined();
	});
});

describe("classify: taxonomy", () => {
	it.each([
		"overloaded_error",
		"Overloaded",
		"model is at capacity",
		"server_busy",
		"currently experiencing high demand",
	])("Overloaded: %s", (text) => {
		expect(run(text).category).toBe("overloaded");
	});

	it("Overloaded: status 529", () => {
		expect(run("request failed", { capture: { status: 529, headers: {} } }).category).toBe("overloaded");
	});

	it.each([
		"fetch failed",
		"ECONNRESET",
		"ECONNREFUSED",
		"ENOTFOUND",
		"EAI_AGAIN",
		"EPIPE",
		"socket hang up",
		"other side closed",
		"terminated",
		"stream ended before",
		"ended without",
		"http2 request did not get a response",
		"pending stream has been canceled",
		"websocket closed",
		"connection reset",
	])("Transport: %s", (text) => {
		expect(run(text)).toMatchObject({ category: "transport", retryable: true });
	});

	it("Unknown error is transient", () => {
		expect(run("Something went wrong (code 7)")).toMatchObject({
			category: "unknown",
			retryable: true,
			reason: "unknown: no known pattern",
		});
	});

	it.each([
		"insufficient_quota",
		"billing",
		"out of budget",
		"BudgetExceededError",
		"PaymentRequiredError",
		"Payment Required",
		"exceeded your current quota",
		"usage limit",
		"subscription_sharing_usage_limit_exceeded",
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
	])("Quota wording: %s", (text) => {
		expect(run(`error: ${text}`).category).toBe("quota");
	});

	it("Quota without hint", () => {
		expect(run("insufficient_quota")).toEqual({ category: "quota", retryable: false, reason: QUOTA_REASON });
	});

	it("Quota with hint inside the limit", () => {
		const result = run('429 You exceeded your current quota ... "retryDelay": "28s"');
		expect(result).toMatchObject({ category: "quota", retryable: true, hint: { delayMs: 28_000 } });
	});

	it("Context overflow", () => {
		expect(run("prompt is too long: 213462 tokens > 200000 maximum")).toMatchObject({
			category: "context_overflow",
			retryable: false,
		});
	});
});

describe("classify: precedence", () => {
	it("Auth error mentioning a status", () => {
		const result = run(
			'401 {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}',
		);
		expect(result).toMatchObject({ category: "auth", retryable: false });
	});

	it("OpenAI 429 that says invalid_request_error", () => {
		const result = run(
			'429 {"error":{"message":"Rate limit reached","type":"invalid_request_error","code":"rate_limit_exceeded"}}',
		);
		expect(result.category).toBe("rate_limit");
	});

	it.each([408, 409, 429, 500, 503])("a recognised %i overrides invalid_request wording", (status) => {
		const result = run("invalid_request_error: try later", { capture: { status, headers: {} } });
		expect(result.category).not.toBe("invalid_request");
		expect(result.retryable).toBe(true);
	});

	it.each(["Throttling error: Too many tokens, please wait before trying again", "429: Too many tokens per minute"])(
		"Throttling that mentions tokens: %s",
		(text) => {
			expect(run(text).category).toBe("rate_limit");
		},
	);

	it("Overflow is not assumed under an overloaded status", () => {
		expect(run("token limit exceeded", { capture: { status: 529, headers: {} } }).category).toBe("overloaded");
	});

	it("Gateway wraps a 429 in a 500", () => {
		const result = run('{"error":{"code":429,"message":"Resource has been exhausted"}}', {
			capture: { status: 500, headers: {} },
		});
		expect(result).toMatchObject({ category: "rate_limit", status: 429 });
	});

	it("a 400 beats transient words", () => {
		expect(run("400 Bad Request: you mentioned a rate limit in your prompt").category).toBe("invalid_request");
	});
});

describe("classify: HTTP status recognition", () => {
	it.each([
		["429 slow down", 429],
		["503: upstream", 503],
		["Request failed with status code 502", 502],
		["status: 401", 401],
		['{"status":404}', 404],
		["HTTP 413 payload", 413],
		["HTTP/1.1 504 Gateway", 504],
		['{"error":{"code":409}}', 409],
		["OpenAI (503): upstream unavailable", 503],
	])("Status positions in text: %s", (text, status) => {
		expect(recogniseStatus(text, [], undefined)).toBe(status);
	});

	it.each([
		"Requested 500 tokens but the limit for this key is 429 per minute",
		"2026-10-21T07:28:00.500: stream closed",
		"200 OK but the stream broke",
		"connect ECONNREFUSED 127.0.0.1:500",
		"500ms elapsed",
		"(code 7)",
		"status 418",
	])("never recognises %s", (text) => {
		expect(recogniseStatus(text, [], undefined)).toBeUndefined();
	});

	it("prefers the capture, then diagnostics, then text", () => {
		const diagnostics: AssistantMessageDiagnostic[] = [{ type: "x", timestamp: 0, details: { status: 503 } }];
		expect(recogniseStatus("429", diagnostics, { status: 401, headers: {} })).toBe(401);
		expect(recogniseStatus("429", diagnostics, undefined)).toBe(503);
		expect(recogniseStatus("429", [], undefined)).toBe(429);
	});

	it.each([
		[401, "auth"],
		[403, "auth"],
		[402, "quota"],
		[404, "not_found"],
		[400, "invalid_request"],
		[413, "invalid_request"],
		[422, "invalid_request"],
		[408, "timeout"],
		[504, "timeout"],
		[524, "timeout"],
		[409, "rate_limit"],
		[429, "rate_limit"],
		[529, "overloaded"],
		[502, "server_error"],
		[500, "server_error"],
	])("Status map: %i → %s", (status, category) => {
		expect(run("upstream said no", { capture: { status, headers: {} } }).category).toBe(category);
	});

	it("Token count that looks like a status", () => {
		const result = run("Requested 500 tokens but the limit for this key is 429 per minute");
		expect(result.status).toBeUndefined();
		expect(result.category).toBe("unknown");
	});

	it.each(["402 Payment Required", "litellm.PaymentRequiredError: top up"])("Payment required: %s", (text) => {
		expect(run(text)).toMatchObject({ category: "quota", retryable: false });
	});

	it("Status in parentheses", () => {
		expect(run("OpenAI (503): upstream unavailable")).toMatchObject({ category: "server_error", status: 503 });
	});

	it("Transient words beat a generic 5xx", () => {
		const result = run(
			'503 {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
		);
		expect(result.category).toBe("overloaded");
	});

	it("A generic 5xx applies after the words: 500 ThrottlingException", () => {
		expect(run("500 ThrottlingException").category).toBe("rate_limit");
	});

	it("Timestamp is not a status", () => {
		const result = run("2026-10-21T07:28:00.500: stream closed");
		expect(result.status).toBeUndefined();
		expect(result.category).toBe("unknown");
	});
});

describe("classify: provider vocabulary", () => {
	const cases: [string, [string, Category][]][] = [
		[
			"Anthropic error types",
			[
				["rate_limit_error", "rate_limit"],
				["overloaded_error", "overloaded"],
				["authentication_error", "auth"],
				["permission_error", "auth"],
				["not_found_error", "not_found"],
				["invalid_request_error", "invalid_request"],
				["request_too_large", "context_overflow"],
				["api_error", "server_error"],
			],
		],
		[
			"OpenAI error codes",
			[
				["rate_limit_exceeded", "rate_limit"],
				["insufficient_quota", "quota"],
				["invalid_api_key", "auth"],
				["model_not_found", "not_found"],
				["context_length_exceeded", "context_overflow"],
				["content_policy_violation", "content_policy"],
				["server_error", "server_error"],
			],
		],
		[
			"Google and gRPC status names",
			[
				["RESOURCE_EXHAUSTED", "rate_limit"],
				["UNAVAILABLE", "server_error"],
				["DEADLINE_EXCEEDED", "timeout"],
				["PERMISSION_DENIED", "auth"],
				["UNAUTHENTICATED", "auth"],
				["NOT_FOUND", "not_found"],
				["INVALID_ARGUMENT", "invalid_request"],
				["The model is overloaded", "overloaded"],
			],
		],
		[
			"Bedrock exceptions",
			[
				["ThrottlingException", "rate_limit"],
				["ServiceUnavailableException", "server_error"],
				["ModelTimeoutException", "timeout"],
				["ModelStreamErrorException", "server_error"],
				["AccessDeniedException", "auth"],
				["ValidationException", "invalid_request"],
				["ResourceNotFoundException", "not_found"],
				["Throttling error: slow down", "rate_limit"],
				["Service unavailable: try later", "server_error"],
				["Model stream error: broken", "server_error"],
				["Internal server error: oops", "server_error"],
				["Validation error: bad field", "invalid_request"],
			],
		],
		[
			"LiteLLM class names",
			[
				["litellm.ServiceUnavailableError", "server_error"],
				["litellm.InternalServerError", "server_error"],
				["litellm.Timeout", "timeout"],
				["litellm.APIConnectionError", "transport"],
				["litellm.AuthenticationError", "auth"],
				["litellm.PermissionDeniedError", "auth"],
				["litellm.NotFoundError", "not_found"],
				["litellm.BadRequestError", "invalid_request"],
				["litellm.ContextWindowExceededError", "context_overflow"],
				["litellm.ContentPolicyViolationError", "content_policy"],
				["litellm.BudgetExceededError", "quota"],
				["No healthy deployment available", "rate_limit"],
			],
		],
		[
			"Subscription limits",
			[
				["usage limit", "quota"],
				["subscription_sharing_usage_limit_exceeded", "quota"],
				["GoUsageLimitError", "quota"],
				["FreeUsageLimitError", "quota"],
				["Monthly usage limit reached", "quota"],
			],
		],
	];

	for (const [name, rows] of cases) {
		it.each(rows)(`${name}: %s → %s`, (text, category) => {
			expect(run(text).category).toBe(category);
		});
	}

	it("LiteLLM proxy rate limit", () => {
		expect(
			run('litellm.RateLimitError: AnthropicException - {"type":"error","error":{"type":"rate_limit_error"}}').category,
		).toBe("rate_limit");
	});

	it("ChatGPT usage limit with reset time", () => {
		const result = run("You have hit your ChatGPT usage limit (plus). Try again in 12 minutes.");
		expect(result).toMatchObject({ category: "quota", retryable: true, hint: { delayMs: 720_000 } });
	});

	it("Google per-minute quota", () => {
		expect(run("429 Quota exceeded for quota metric 'Generate requests per minute'")).toMatchObject({
			category: "rate_limit",
			retryable: true,
		});
	});

	it("Billing quota", () => {
		expect(run("You exceeded your current quota, please check your plan and billing details")).toMatchObject({
			category: "quota",
			retryable: false,
		});
	});
});

interface PiRow {
	/** The entry of Pi's built-in list this row covers. */
	entry: string;
	text: string;
	category: Category;
	retryable: boolean;
	/** Verified difference from Pi's `isRetryableAssistantError`. */
	differs?: true;
}

// Pi's two lists are not exported, so their entries are copied from the installed `pi-ai/dist/utils/retry.js`.
const PI_NON_RETRYABLE: PiRow[] = [
	{
		entry: "GoUsageLimitError",
		text: '429 {"error":{"type":"GoUsageLimitError"}}',
		category: "quota",
		retryable: false,
	},
	{
		entry: "FreeUsageLimitError",
		text: '429 {"error":{"type":"FreeUsageLimitError"}}',
		category: "quota",
		retryable: false,
	},
	{
		entry: "Monthly usage limit reached",
		text: "Monthly usage limit reached",
		category: "quota",
		retryable: false,
	},
	{
		entry: "available balance",
		text: "Enable usage from your available balance to continue",
		category: "quota",
		retryable: false,
	},
	{ entry: "insufficient_quota", text: "429 insufficient_quota", category: "quota", retryable: false },
	{ entry: "out of budget", text: "Key is out of budget", category: "quota", retryable: false },
	{
		entry: "quota exceeded",
		text: "429 Quota exceeded for quota metric 'Generate requests per minute'",
		category: "rate_limit",
		retryable: true,
		differs: true,
	},
	{ entry: "billing", text: "Please check your billing details", category: "quota", retryable: false },
	{
		entry: "subscription_sharing_usage_limit_exceeded",
		text: "subscription_sharing_usage_limit_exceeded",
		category: "quota",
		retryable: false,
	},
];

const PI_RETRYABLE: PiRow[] = [
	{ entry: "overloaded", text: "Overloaded", category: "overloaded", retryable: true },
	{ entry: "server_busy", text: "server_busy", category: "overloaded", retryable: true },
	{
		entry: "servers are currently busy",
		text: "Our servers are currently busy",
		category: "overloaded",
		retryable: true,
	},
	{
		entry: "currently experiencing high demand",
		text: "We are currently experiencing high demand",
		category: "overloaded",
		retryable: true,
	},
	{ entry: "model is at capacity", text: "The model is at capacity", category: "overloaded", retryable: true },
	{ entry: "rate.?limit", text: "rate-limited by upstream", category: "rate_limit", retryable: true },
	{ entry: "too many requests", text: "Too Many Requests", category: "rate_limit", retryable: true },
	{ entry: "429", text: "429 slow down", category: "rate_limit", retryable: true },
	{ entry: "500", text: "500 oops", category: "server_error", retryable: true },
	{ entry: "502", text: "502 upstream", category: "server_error", retryable: true },
	{ entry: "503", text: "503 later", category: "server_error", retryable: true },
	{ entry: "504", text: "504 upstream", category: "timeout", retryable: true },
	{ entry: "520", text: "520 cloudflare", category: "server_error", retryable: true },
	{ entry: "524", text: "524 cloudflare", category: "timeout", retryable: true },
	{
		entry: "bare status number",
		text: "400 messages.500.content: text content blocks must be non-empty",
		category: "invalid_request",
		retryable: false,
		differs: true,
	},
	{ entry: "service.?unavailable", text: "Service Unavailable", category: "server_error", retryable: true },
	{ entry: "server.?error", text: "server error", category: "server_error", retryable: true },
	{ entry: "internal.?error", text: "internal error", category: "server_error", retryable: true },
	{ entry: "provider.?returned.?error", text: "Provider returned error", category: "server_error", retryable: true },
	{
		entry: "exceeded request buffer limit while retrying upstream",
		text: "exceeded request buffer limit while retrying upstream",
		category: "server_error",
		retryable: true,
	},
	{ entry: "network.?error", text: "network error", category: "transport", retryable: true },
	{ entry: "connection.?error", text: "Connection error.", category: "transport", retryable: true },
	{ entry: "connection.?refused", text: "connection refused", category: "transport", retryable: true },
	{ entry: "connection.?lost", text: "connection lost", category: "transport", retryable: true },
	{ entry: "other side closed", text: "other side closed", category: "transport", retryable: true },
	{ entry: "fetch failed", text: "fetch failed", category: "transport", retryable: true },
	{ entry: "getaddrinfo", text: "getaddrinfo EAI_FAIL", category: "transport", retryable: true },
	{ entry: "ENOTFOUND", text: "ENOTFOUND", category: "transport", retryable: true },
	{ entry: "EAI_AGAIN", text: "EAI_AGAIN", category: "transport", retryable: true },
	{ entry: "upstream.?connect", text: "upstream connect error", category: "transport", retryable: true },
	{ entry: "reset before headers", text: "reset before headers", category: "transport", retryable: true },
	{ entry: "socket hang up", text: "socket hang up", category: "transport", retryable: true },
	{
		entry: "socket connection was closed",
		text: "The socket connection was closed unexpectedly",
		category: "transport",
		retryable: true,
	},
	{ entry: "timed? out", text: "Request timed out", category: "timeout", retryable: true },
	{ entry: "timeout", text: "timeout", category: "timeout", retryable: true },
	{ entry: "terminated", text: "terminated", category: "transport", retryable: true },
	{ entry: "websocket.?closed", text: "websocket closed", category: "transport", retryable: true },
	{ entry: "websocket.?error", text: "websocket error", category: "transport", retryable: true },
	{ entry: "ended without", text: "stream ended without a stop event", category: "transport", retryable: true },
	{
		entry: "stream ended before message_stop",
		text: "stream ended before message_stop",
		category: "transport",
		retryable: true,
	},
	{
		entry: "stream ended before a terminal response event",
		text: "stream ended before a terminal response event",
		category: "transport",
		retryable: true,
	},
	{
		entry: "http2 request did not get a response",
		text: "http2 request did not get a response",
		category: "transport",
		retryable: true,
	},
	{
		entry: "pending stream has been canceled",
		text: "The pending stream has been canceled",
		category: "transport",
		retryable: true,
	},
	{
		entry: "retry delay",
		text: "Server requested 90s retry delay (max: 60s)",
		category: "rate_limit",
		retryable: true,
	},
	{
		entry: "you can retry your request",
		text: "You can retry your request",
		category: "server_error",
		retryable: true,
	},
	{ entry: "try your request again", text: "Try your request again", category: "server_error", retryable: true },
	{ entry: "please retry your request", text: "Please retry your request", category: "server_error", retryable: true },
	{ entry: "ResourceExhausted", text: "ResourceExhausted", category: "rate_limit", retryable: true },
	{
		entry: "subscription_sharing_usage_unavailable",
		text: "subscription_sharing_usage_unavailable",
		category: "server_error",
		retryable: true,
	},
	{
		entry: "subscription_sharing_user_unavailable",
		text: "subscription_sharing_user_unavailable",
		category: "server_error",
		retryable: true,
	},
];

describe("classify: Pi's built-in lists", () => {
	it.each([...PI_NON_RETRYABLE, ...PI_RETRYABLE])("$entry", (row) => {
		const result = run(row.text);
		expect(result.category).toBe(row.category);
		expect(result.retryable).toBe(row.retryable);
		const agrees = isRetryableAssistantError(failure(row.text)) === result.retryable;
		expect(agrees).toBe(row.differs !== true);
	});

	it("differs from Pi only on plain quota exceeded and bare status numbers", () => {
		const differing = [...PI_NON_RETRYABLE, ...PI_RETRYABLE].filter((row) => row.differs).map((row) => row.entry);
		expect(differing).toEqual(["quota exceeded", "bare status number"]);
	});
});

describe("classify: user-defined patterns", () => {
	it("Custom gateway wording", () => {
		const result = run("gateway: backend saturated, id=7", { patterns: { retryable: ["backend saturated"] } });
		expect(result).toMatchObject({ category: "unknown", retryable: true });
		expect(result.reason).toContain("matches retryable pattern /backend saturated/i");
	});

	it("Forced stop", () => {
		const result = run("503 tenant suspended", { patterns: { nonRetryable: ["tenant suspended"] } });
		expect(result).toMatchObject({ category: "server_error", retryable: false });
		expect(result.reason).toContain("matches nonRetryable pattern /tenant suspended/i");
	});

	it("Forced retry of a quota error", () => {
		const result = run("429 insufficient_quota", { patterns: { retryable: ["insufficient_quota"] } });
		expect(result).toMatchObject({ category: "quota", retryable: true });
		expect(result.hint).toBeUndefined();
	});

	it("Forced stop of a quota error with an accepted hint", () => {
		const result = run("usage limit reached. Try again in 5 minutes.", { patterns: { nonRetryable: ["usage limit"] } });
		expect(result).toMatchObject({ category: "quota", retryable: false });
		expect(result.hint).toBeUndefined();
	});

	it("Override cannot lift the limit", () => {
		const result = run("Rate limited. Try again in 2 hours.", { patterns: { retryable: ["rate limited"] } });
		expect(result).toEqual({
			category: "rate_limit",
			retryable: false,
			reason: "provider asked to wait 2h, limit is 30m",
		});
	});

	it("A nonRetryable override does not replace the limit reason", () => {
		const result = run("usage limit reached. Try again in 2 hours.", { patterns: { nonRetryable: ["usage limit"] } });
		expect(result).toEqual({ category: "quota", retryable: false, reason: "provider asked to wait 2h, limit is 30m" });
	});

	it("An unsupported unit leaves a quota error without a hint", () => {
		expect(run("usage limit reached; retry after 2 days")).toEqual({
			category: "quota",
			retryable: false,
			reason: "quota or billing limit without a reset time",
		});
	});

	it("A quota hint above the limit is not retryable with the limit reason", () => {
		const result = run("usage limit reached. Try again in 2 hours.");
		expect(result).toEqual({ category: "quota", retryable: false, reason: "provider asked to wait 2h, limit is 30m" });
	});

	it("matches patterns against diagnostic codes too", () => {
		const result = run("request failed", {
			diagnostics: [{ type: "x", timestamp: 0, details: { errorCode: "TenantSuspended" } }],
			patterns: { nonRetryable: ["tenantsuspended"] },
		});
		expect(result.retryable).toBe(false);
	});
});

describe("classify: final decision precedence", () => {
	it("Both overrides match", () => {
		const result = run("flaky backend", { patterns: { retryable: ["flaky"], nonRetryable: ["backend"] } });
		expect(result.retryable).toBe(false);
	});

	it("Built-in rule applies", () => {
		const result = run("429 rate limited, retry after 10 seconds");
		expect(result).toMatchObject({ category: "rate_limit", retryable: true, hint: { delayMs: 10_000 } });
	});

	it("honours any hint when the limit is disabled", () => {
		const result = run("Rate limited. Try again in 2 hours.", { maxRetryAfterMs: 0 });
		expect(result).toMatchObject({ retryable: true, hint: { delayMs: 7_200_000 } });
	});

	it("Reason for a stop", () => {
		expect(run("401").reason).toBe("auth: HTTP 401");
		expect(run("request failed", { capture: { status: 401, headers: {} } }).reason).toBe("auth: HTTP 401");
	});
});
