# error-classification Specification

## Purpose
Assigns every failed model request a category and a retry decision, so that deterministic failures stop immediately and transient ones are retried, across providers and API styles.

## Requirements

### Requirement: Classification inputs
A failed model request SHALL be classified from the assistant message's error text, provider, diagnostics, and any error-status HTTP capture for that request. Only a message with stop reason `error` is classified; aborted and successful messages SHALL never be classified or retried.

#### Scenario: Inputs consulted
- **WHEN** a failure is classified
- **THEN** the inputs are the error text, the provider id, the diagnostics fields `details.status`, `details.errorCode` (Bedrock), `details.error.code` and `details.error.type` (pi-messages' parsed provider error object) and `error.code` (the thrown exception's code) when present, and the status and headers captured through `after_provider_response` when that event fired with status 400 or higher for this request

#### Scenario: Error text only
- **WHEN** an assistant message has stop reason `error`, the text `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization's rate limit"}}` and no diagnostics
- **THEN** the message is classified as `rate_limit` and retryable

#### Scenario: Diagnostic error code
- **WHEN** the error text is `Validation error: malformed input` and a diagnostic carries `details.errorCode: "ValidationException"`
- **THEN** the category is `invalid_request` and the failure is not retryable

#### Scenario: Deterministic type only in a nested diagnostic
- **WHEN** the error text is `429 Too Many Requests: slow down` and a diagnostic carries `details.error.type: "insufficient_quota"`
- **THEN** the category is `quota` and the failure is not retryable without an accepted hint

#### Scenario: Aborted message
- **WHEN** an assistant message has stop reason `aborted`
- **THEN** no classification is made and no retry is scheduled

### Requirement: Category taxonomy
Each failure SHALL receive exactly one category: `rate_limit`, `overloaded`, `server_error`, `timeout`, `transport`, `quota`, `auth`, `not_found`, `invalid_request`, `content_policy`, `context_overflow`, or `unknown`.

#### Scenario: Overloaded
- **WHEN** the error text contains `overloaded_error`, `Overloaded`, `model is at capacity`, `server_busy`, `currently experiencing high demand` or HTTP status 529
- **THEN** the category is `overloaded`

#### Scenario: Transport
- **WHEN** the error text contains `fetch failed`, `ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `socket hang up`, `other side closed`, `terminated`, `stream ended before`, `ended without`, `http2 request did not get a response`, `pending stream has been canceled`, `websocket closed` or `connection reset`
- **THEN** the category is `transport`

### Requirement: Retry decision by category
`rate_limit`, `overloaded`, `server_error`, `timeout`, `transport` and `unknown` SHALL be retryable. `auth`, `not_found`, `invalid_request`, `content_policy` and `context_overflow` SHALL NOT be retryable. `quota` SHALL be retryable only when a retry hint within the accepted limit is present (see retry-hints).

#### Scenario: Unknown error is transient
- **WHEN** the error text is `Something went wrong (code 7)` and matches no known pattern
- **THEN** the category is `unknown` and the failure is retryable

#### Scenario: Quota wording
- **WHEN** the error text contains one of `insufficient_quota`, `billing`, `out of budget`, `BudgetExceededError`, `PaymentRequiredError`, `Payment Required`, `exceeded your current quota`, `usage limit`, `subscription_sharing_usage_limit_exceeded`, `subscription_sharing_workplace_individual_usage_limit_exceeded`, `GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`, `available balance`, other than Pi's Codex usage-limit message that carries no usable reset time (no reset at all, or ` Try again in ~0 min.`); see "Codex usage limit without a reset time"
- **THEN** the category is `quota`

#### Scenario: Quota without hint
- **WHEN** the error text contains `insufficient_quota` and no retry hint is found
- **THEN** the category is `quota` and the failure is not retryable, with the reason `quota or billing limit without a reset time`

#### Scenario: Quota with hint inside the limit
- **WHEN** the error text is `429 You exceeded your current quota ... "retryDelay": "28s"` and the accepted limit is 30 minutes
- **THEN** the category is `quota` and the failure is retryable with a 28 s delay

#### Scenario: Context overflow
- **WHEN** the error text is `prompt is too long: 213462 tokens > 200000 maximum`
- **THEN** the category is `context_overflow` and the failure is not retryable

### Requirement: Deterministic categories take precedence
When the error text matches both a deterministic pattern (`auth`, `not_found`, `invalid_request`, `content_policy`, `context_overflow`, `quota`) and a transient pattern, the deterministic category SHALL win, except that a recognised HTTP status of 408, 409, 429 or 5xx (captured, from diagnostics, or from the text) SHALL override a text match for `invalid_request`. Context overflow SHALL NOT be assumed when the recognised status is 429 or 529 or a `rate_limit` / `overloaded` word rule matches. When the text matches both `quota` and `invalid_request` wording, `quota` SHALL win. Pi's Codex usage-limit message that carries no usable reset time SHALL be `rate_limit`, although it contains `usage limit` wording (see Provider vocabulary, "Codex usage limit without a reset time").

#### Scenario: Auth error mentioning a status
- **WHEN** the error text is `401 {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}`
- **THEN** the category is `auth` and the failure is not retryable

#### Scenario: OpenAI 429 that says invalid_request_error
- **WHEN** the error text is `429 {"error":{"message":"Rate limit reached","type":"invalid_request_error","code":"rate_limit_exceeded"}}` with no captured status
- **THEN** the category is `rate_limit`

#### Scenario: Throttling that mentions tokens
- **WHEN** the error text is `Throttling error: Too many tokens, please wait before trying again` or `429: Too many tokens per minute`
- **THEN** the category is `rate_limit`, not `context_overflow`

#### Scenario: Gateway wraps a 429 in a 500
- **WHEN** the captured HTTP status is 500 and the body is `{"error":{"code":429,"message":"Resource has been exhausted"}}`
- **THEN** the category is `rate_limit`

#### Scenario: Low credit balance typed as an invalid request
- **WHEN** the error text is `400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}` and no hint is found
- **THEN** the category is `quota` and the failure is not retryable, with the reason `quota or billing limit without a reset time`

### Requirement: HTTP status recognition
An HTTP status SHALL be taken from the captured response or diagnostics when available; otherwise a three-digit code in the error text SHALL count as a status only in a status position, so that token counts and identifiers are not mistaken for statuses. A recognised status maps to a category.

#### Scenario: Status positions in text
- **WHEN** no status is captured and the text contains one of the mapped HTTP error codes (400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500–599) at its start (optionally followed by `:`), or after `status`, `HTTP`, `code` or `(`
- **THEN** that code is the recognised status; other three-digit numbers, including `200`, port numbers and millisecond fields, are never recognised

#### Scenario: Status map
- **WHEN** a status is recognised
- **THEN** it maps as 401/403 → `auth`; 402 → `quota`; 404 → `not_found`; 400/413/422 → `invalid_request`; 408/504/524 → `timeout`; 409/429 → `rate_limit`; 529 → `overloaded`; other 5xx → `server_error`, applied only when no transient word rule matched

#### Scenario: Token count that looks like a status
- **WHEN** the error text is `Requested 500 tokens but the limit for this key is 429 per minute` with no captured status
- **THEN** no status is recognised from the text and classification proceeds on words alone

#### Scenario: Payment required
- **WHEN** the error text is `402 Payment Required` or contains `PaymentRequiredError`
- **THEN** the category is `quota` and the failure is not retryable without an accepted hint

#### Scenario: Status in parentheses
- **WHEN** the error text is `OpenAI (503): upstream unavailable`
- **THEN** status 503 is recognised and the category is `server_error`

#### Scenario: Transient words beat a generic 5xx
- **WHEN** the error text is `503 {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}`
- **THEN** the category is `overloaded`, not `server_error`

#### Scenario: Timestamp is not a status
- **WHEN** the error text is `2026-10-21T07:28:00.500: stream closed` with no captured status
- **THEN** no status is recognised and the category is `unknown`

### Requirement: Provider vocabulary
The classifier SHALL recognise the error wording of every provider API Pi ships (Anthropic, OpenAI Completions/Responses/Codex, Google, Bedrock, Mistral), of common gateways (OpenRouter, LiteLLM proxy including its exception class names, gRPC status names), of subscription usage limits, and every pattern of Pi's own retryable and non-retryable lists (checked against Pi 1.4). The vocabulary SHALL be kept as reviewable tables with a source note per group.

#### Scenario: Anthropic error types
- **WHEN** the error text contains one of `rate_limit_error`, `overloaded_error`, `authentication_error`, `permission_error`, `not_found_error`, `invalid_request_error`, `request_too_large`, `api_error`
- **THEN** the categories are, in order, `rate_limit`, `overloaded`, `auth`, `auth`, `not_found`, `invalid_request`, `context_overflow`, `server_error`

#### Scenario: OpenAI error codes
- **WHEN** the error text contains one of `rate_limit_exceeded`, `insufficient_quota`, `invalid_api_key`, `model_not_found`, `context_length_exceeded`, `content_policy_violation`, `server_error`
- **THEN** the categories are, in order, `rate_limit`, `quota`, `auth`, `not_found`, `context_overflow`, `content_policy`, `server_error`

#### Scenario: Google and gRPC status names
- **WHEN** the error text contains one of `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `PERMISSION_DENIED`, `UNAUTHENTICATED`, `NOT_FOUND`, `INVALID_ARGUMENT`, `The model is overloaded`
- **THEN** the categories are, in order, `rate_limit`, `server_error`, `timeout`, `auth`, `auth`, `not_found`, `invalid_request`, `overloaded`

#### Scenario: Bedrock exceptions
- **WHEN** the error text or a diagnostic `errorCode` contains one of `ThrottlingException`, `ServiceUnavailableException`, `ModelTimeoutException`, `ModelStreamErrorException`, `AccessDeniedException`, `ValidationException`, `ResourceNotFoundException`, or the text starts with Pi's prefixes `Throttling error:`, `Service unavailable:`, `Model stream error:`, `Internal server error:`, `Validation error:`
- **THEN** the categories are, in order, `rate_limit`, `server_error`, `timeout`, `server_error`, `auth`, `invalid_request`, `not_found`, and for the prefixes `rate_limit`, `server_error`, `server_error`, `server_error`, `invalid_request`

#### Scenario: LiteLLM proxy rate limit
- **WHEN** the error text is `litellm.RateLimitError: AnthropicException - {"type":"error","error":{"type":"rate_limit_error"}}`
- **THEN** the category is `rate_limit`

#### Scenario: LiteLLM class names
- **WHEN** the error text contains one of `litellm.ServiceUnavailableError`, `litellm.InternalServerError`, `litellm.Timeout`, `litellm.APIConnectionError`, `litellm.AuthenticationError`, `litellm.PermissionDeniedError`, `litellm.NotFoundError`, `litellm.BadRequestError`, `litellm.ContextWindowExceededError`, `litellm.ContentPolicyViolationError`, `litellm.BudgetExceededError`, `No healthy deployment available`
- **THEN** the categories are, in order, `server_error`, `server_error`, `timeout`, `transport`, `auth`, `auth`, `not_found`, `invalid_request`, `context_overflow`, `content_policy`, `quota`, `rate_limit`

#### Scenario: Gateway and stream failures added in Pi 1.4
- **WHEN** the error text contains one of `stream disconnected before completion`, `stream was interrupted`, `HTTP/2 stream failed`, `request to https://oauth2.googleapis.com/token failed, reason:`, `upstream_request_failed`, `upstream_stream_read_error`
- **THEN** the categories are, in order, `transport`, `transport`, `transport`, `transport`, `server_error`, `server_error`, every one is retryable, and the reason names the matched wording instead of `no known pattern`

#### Scenario: Subscription limits
- **WHEN** the error text contains one of `usage limit`, `subscription_sharing_usage_limit_exceeded`, `subscription_sharing_workplace_individual_usage_limit_exceeded`, `GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`, other than Pi's Codex usage-limit message that carries no usable reset time (no reset at all, or ` Try again in ~0 min.`); see "Codex usage limit without a reset time"
- **THEN** the category is `quota`

#### Scenario: Codex usage limit without a reset time
- **WHEN** the whole error message (the error text itself, apart from any diagnostics) is Pi's Codex message `You have hit your ChatGPT usage limit.` or `You have hit your ChatGPT usage limit (<plan> plan).`, optionally followed by ` Try again in ~0 min.`. Pi's Codex adapter renders the message for every HTTP 429 with a JSON error body, including a transient `rate_limit_exceeded`, and for any status whose error `code`, or `type` when `code` is absent, contains `usage_limit_reached`, `usage_not_included` or `rate_limit_exceeded`. It adds a reset time only when the body has `resets_at`, and writes `~0 min` when that reset is less than 30 s away or already past.
- **THEN** the category is `rate_limit` and the reason names the matched message. The retry decision then follows the usual rules: with no header, diagnostic or text hint the failure is retried with backoff; an accepted header hint (Codex over SSE) sets the delay; a hint above the acceptance limit or a `nonRetryable` user pattern stops the retry.
- **AND** the same holds when the message carries diagnostics, such as the transport diagnostic Pi attaches after a WebSocket-to-SSE fallback
- **AND** the same message followed by `Try again in ~12 min.` stays `quota` with a 12-minute hint

#### Scenario: ChatGPT usage limit with reset time
- **WHEN** the error text is `You have hit your ChatGPT usage limit (plus). Try again in 12 minutes.`
- **THEN** the category is `quota`, a 12-minute hint is found, and the failure is retryable when the limit is 30 minutes

#### Scenario: Pi's lists are covered with documented differences
- **WHEN** an error text matches an entry of Pi 1.4's built-in retryable or non-retryable lists, and no user pattern is configured
- **THEN** the decision follows pi-retry's category, status and hint rules, not Pi's wording-only decision (Pi's overflow check, then `isRetryableAssistantError`). Pi's lists are covered, but the two decisions deliberately differ, as in these examples:
  - `quota exceeded`: Pi stops; here `rate_limit`, retried, because Google's per-minute `Quota exceeded for quota metric` resets.
  - A Gemini 429 that says `billing` and `Quota exceeded` and carries `"retryDelay": "33s"`: Pi stops; here `quota` with an accepted hint, retried.
  - `Server requested 3600s retry delay (max: 60s)`: Pi retries; here not retried, because the hint is above the acceptance limit.
  - `400 Provider returned error`: Pi retries; here `invalid_request`, not retried. The same holds when the 400 is captured or comes from diagnostics.
  - `503 model not found`: Pi retries; here `not_found`, not retried.
  - `429 You exceeded your current quota.`: Pi retries; here `quota` without a hint, not retried.
  - `500 litellm.ContextWindowExceededError`: Pi retries; here `context_overflow`, not retried.
  - `429: Too many tokens per minute`: Pi treats it as context overflow, compacts the context and re-sends; here `rate_limit`, retried after a wait.
- **AND** these agree with Pi: `429 insufficient_quota` stops (`quota` without a hint), and OpenAI's `429 … invalid_request_error … rate_limit_exceeded` is retried (`rate_limit`)
- **AND** Pi recognises 429, 500, 502, 503, 504, 520 and 524 wherever no letter or digit touches the number; here a number counts only in a status position

#### Scenario: Google per-minute quota
- **WHEN** the error text is `429 Quota exceeded for quota metric 'Generate requests per minute'`
- **THEN** the category is `rate_limit` and the failure is retryable

#### Scenario: Billing quota
- **WHEN** the error text is `You exceeded your current quota, please check your plan and billing details` with no hint
- **THEN** the category is `quota` and the failure is not retryable

### Requirement: User-defined patterns
Patterns from the configuration (`patterns.retryable`, `patterns.nonRetryable`) SHALL be tested before the built-in vocabulary. A `nonRetryable` match makes the failure non-retryable; a `retryable` match makes it retryable even for a built-in deterministic category such as `quota` without a hint. `nonRetryable` wins over `retryable`. The category stays the built-in one, or `unknown` when none matches. Neither override lifts the retry-after acceptance limit.

#### Scenario: Custom gateway wording
- **WHEN** `patterns.retryable` contains `"backend saturated"` and the error text is `gateway: backend saturated, id=7`
- **THEN** the failure is retryable with category `unknown`

#### Scenario: Forced stop
- **WHEN** `patterns.nonRetryable` contains `"tenant suspended"` and the error text is `503 tenant suspended`
- **THEN** the failure is not retryable although 503 is a transient status

#### Scenario: Forced retry of a quota error
- **WHEN** `patterns.retryable` contains `"insufficient_quota"` and the error text contains `insufficient_quota` with no hint
- **THEN** the failure is retryable with category `quota` and backoff applies

#### Scenario: Override cannot lift the limit
- **WHEN** `patterns.retryable` matches and the hint is 2 h against a 30 min limit
- **THEN** the failure is not retryable with the limit reason

### Requirement: Final decision precedence
The retry decision SHALL be resolved in this order, first match wins: (1) a hint above the acceptance limit → not retryable; (2) a `nonRetryable` user pattern → not retryable; (3) a `retryable` user pattern → retryable; (4) the built-in category rule, where `quota` is retryable only with an accepted hint.

#### Scenario: Both overrides match
- **WHEN** the error text matches both a `retryable` and a `nonRetryable` user pattern
- **THEN** the failure is not retryable

#### Scenario: Built-in rule applies
- **WHEN** no user pattern matches, the category is `rate_limit` and the hint is 10 s
- **THEN** the failure is retryable with a 10 s delay

### Requirement: Classification result is explainable
Every classification SHALL carry the category, the retry decision, and a short human-readable reason naming the matched evidence (status, pattern or hint), which the extension uses in notifications and session records.

#### Scenario: Reason for a stop
- **WHEN** a failure is classified as `auth` from status 401
- **THEN** the reason reads `auth: HTTP 401`
