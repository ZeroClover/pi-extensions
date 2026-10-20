/** Every category a failure can receive. */
export type Category =
	| "rate_limit"
	| "overloaded"
	| "server_error"
	| "timeout"
	| "transport"
	| "quota"
	| "auth"
	| "not_found"
	| "invalid_request"
	| "content_policy"
	| "context_overflow"
	| "unknown";

/** Categories that never succeed on a plain retry; `quota` succeeds only after its reset time. */
export type DeterministicCategory =
	| "context_overflow"
	| "auth"
	| "not_found"
	| "content_policy"
	| "invalid_request"
	| "quota";
export type TransientCategory = "rate_limit" | "overloaded" | "timeout" | "transport" | "server_error";

export interface Rule<C extends Category = Category> {
	pattern: RegExp;
	category: C;
}

/**
 * Deterministic wording, tested in this order of categories. Pi's `isContextOverflow` runs before these, so the
 * overflow group only adds wording Pi does not know.
 */
export const DETERMINISTIC_RULES: readonly Rule<DeterministicCategory>[] = [
	// Overflow: LiteLLM `ContextWindowExceededError`, OpenAI `context_length_exceeded`, Anthropic HTTP 413 type.
	{ pattern: /context.?window.?exceeded/i, category: "context_overflow" },
	{ pattern: /context.?length.?exceeded/i, category: "context_overflow" },
	{ pattern: /request_too_large/i, category: "context_overflow" },

	// Auth: Anthropic `authentication_error` / `permission_error`, OpenAI `invalid_api_key`, gRPC `UNAUTHENTICATED` /
	// `PERMISSION_DENIED`, Bedrock `AccessDeniedException`, LiteLLM `AuthenticationError` / `PermissionDeniedError`.
	{ pattern: /authentication.?(?:error|failed)/i, category: "auth" },
	{ pattern: /permission.?(?:error|denied)/i, category: "auth" },
	{ pattern: /invalid.?api.?key|incorrect api key|invalid x-api-key|api key not valid/i, category: "auth" },
	{ pattern: /unauthenticated|(?<![a-z])unauthori[sz]ed/i, category: "auth" },
	{ pattern: /access.?denied/i, category: "auth" },

	// Not found: Anthropic `not_found_error`, OpenAI `model_not_found`, gRPC `NOT_FOUND`, LiteLLM `NotFoundError`,
	// Bedrock `ResourceNotFoundException`. The look-behind keeps `ENOTFOUND` (a DNS failure) out.
	{ pattern: /(?<![a-z])not[ _]?found/i, category: "not_found" },
	{ pattern: /ResourceNotFound/i, category: "not_found" },
	{ pattern: /does not exist or you do not have access/i, category: "not_found" },

	// Content policy: OpenAI `content_policy_violation`, LiteLLM `ContentPolicyViolationError`, Azure `content_filter`.
	{ pattern: /content.?policy/i, category: "content_policy" },
	{ pattern: /content.?filter/i, category: "content_policy" },

	// Invalid request: Anthropic/OpenAI `invalid_request_error`, gRPC `INVALID_ARGUMENT`, Bedrock `ValidationException`
	// and Pi's `Validation error:` prefix, LiteLLM `BadRequestError`.
	{ pattern: /invalid.?request/i, category: "invalid_request" },
	{ pattern: /invalid.?argument/i, category: "invalid_request" },
	{ pattern: /validation.?(?:exception|error)/i, category: "invalid_request" },
	{ pattern: /bad.?request/i, category: "invalid_request" },

	// Quota: Pi's non-retryable list without its plain `quota exceeded` (Google uses it for per-minute limits), OpenAI
	// `insufficient_quota` and its billing text, LiteLLM `BudgetExceededError`, HTTP 402 wording, ChatGPT and OpenCode
	// subscription limits.
	{ pattern: /insufficient_quota/i, category: "quota" },
	{ pattern: /exceeded your current quota/i, category: "quota" },
	{ pattern: /billing/i, category: "quota" },
	{ pattern: /out of budget|budget.?exceeded/i, category: "quota" },
	{ pattern: /payment.?required/i, category: "quota" },
	{ pattern: /usage.?limit/i, category: "quota" },
	{ pattern: /available balance/i, category: "quota" },
];

/** Transient wording, tested in this order of categories after the specific HTTP statuses. */
export const TRANSIENT_RULES: readonly Rule<TransientCategory>[] = [
	// Rate limits: Pi's `rate.?limit` / `too many requests` / `ResourceExhausted` / `retry delay`, Anthropic
	// `rate_limit_error`, OpenAI `rate_limit_exceeded`, Bedrock `ThrottlingException` and Pi's `Throttling error:`
	// prefix, gRPC `RESOURCE_EXHAUSTED`, Google's per-minute `Quota exceeded for quota metric`, LiteLLM's router.
	{ pattern: /rate.?limit/i, category: "rate_limit" },
	{ pattern: /too many requests/i, category: "rate_limit" },
	{ pattern: /throttl/i, category: "rate_limit" },
	{ pattern: /resource.?(?:has been )?exhausted/i, category: "rate_limit" },
	{ pattern: /quota.?exceeded/i, category: "rate_limit" },
	{ pattern: /no healthy deployment/i, category: "rate_limit" },
	{ pattern: /retry delay/i, category: "rate_limit" },

	// Overload: Pi's list, Anthropic `overloaded_error` (HTTP 529), Google `The model is overloaded`.
	{ pattern: /overloaded/i, category: "overloaded" },
	{ pattern: /at capacity/i, category: "overloaded" },
	{ pattern: /server_busy|servers are currently busy/i, category: "overloaded" },
	{ pattern: /high demand/i, category: "overloaded" },

	// Timeouts: Pi's `timed? out` / `timeout`, gRPC `DEADLINE_EXCEEDED`, Bedrock `ModelTimeoutException`, LiteLLM `Timeout`.
	{ pattern: /timed? ?out/i, category: "timeout" },
	{ pattern: /deadline.?exceeded/i, category: "timeout" },

	// Transport: Pi's network, fetch, socket, WebSocket and premature-stream-end wording, Node error codes, LiteLLM
	// `APIConnectionError`.
	{ pattern: /fetch failed|network.?error|getaddrinfo/i, category: "transport" },
	{ pattern: /connection.?(?:error|refused|lost|reset)/i, category: "transport" },
	{ pattern: /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE/i, category: "transport" },
	{ pattern: /socket hang up|socket connection was closed|other side closed/i, category: "transport" },
	{ pattern: /upstream.?connect|reset before headers/i, category: "transport" },
	{ pattern: /terminated/i, category: "transport" },
	{ pattern: /stream ended before|ended without/i, category: "transport" },
	{ pattern: /http2 request did not get a response|pending stream has been canceled/i, category: "transport" },
	{ pattern: /websocket.?(?:closed|error)/i, category: "transport" },

	// Server errors: Pi's `server.?error` / `internal.?error` / `service.?unavailable` / gateway wording, Anthropic
	// `api_error`, gRPC `UNAVAILABLE`, Bedrock `ServiceUnavailableException` / `ModelStreamErrorException` and Pi's
	// `Model stream error:` prefix, OpenAI's "you can retry" guidance, ChatGPT's temporary unavailability.
	{ pattern: /server.?error|internal.?error|api_error/i, category: "server_error" },
	{
		pattern: /service.?(?:is.?)?(?:temporarily.?)?unavailable|(?<![a-z])unavailable(?![a-z])/i,
		category: "server_error",
	},
	{ pattern: /model.?stream.?error/i, category: "server_error" },
	{ pattern: /bad gateway/i, category: "server_error" },
	{ pattern: /provider.?returned.?(?:an.?)?error|unable to forward upstream/i, category: "server_error" },
	{ pattern: /exceeded request buffer limit while retrying upstream/i, category: "server_error" },
	{ pattern: /you can retry your request|try your request again|please retry your request/i, category: "server_error" },
];

/** HTTP statuses that decide the category before transient wording does. */
export const SPECIFIC_STATUSES: Readonly<Record<number, Category>> = {
	400: "invalid_request",
	401: "auth",
	402: "quota",
	403: "auth",
	404: "not_found",
	408: "timeout",
	409: "rate_limit",
	413: "invalid_request",
	422: "invalid_request",
	429: "rate_limit",
	504: "timeout",
	524: "timeout",
	529: "overloaded",
};

/** Statuses recognised from error text: the specific ones and every 5xx. */
export function isMappedStatus(status: number): boolean {
	return status in SPECIFIC_STATUSES || (status >= 500 && status <= 599);
}

export function isDeterministic(category: Category): category is DeterministicCategory {
	return DETERMINISTIC_RULES.some((rule) => rule.category === category);
}
