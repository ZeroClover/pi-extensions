# Spec Delta

## MODIFIED Requirements

### Requirement: Retry decision by category
`rate_limit`, `overloaded`, `server_error`, `timeout`, `transport` and `unknown` SHALL be retryable. `auth`, `not_found`, `invalid_request`, `content_policy` and `context_overflow` SHALL NOT be retryable. `quota` SHALL be retryable only when a retry hint within the accepted limit is present (see retry-hints).

#### Scenario: Unknown error is transient
- **WHEN** the error text is `Something went wrong (code 7)` and matches no known pattern
- **THEN** the category is `unknown` and the failure is retryable

#### Scenario: Quota wording
- **WHEN** the error text contains one of `insufficient_quota`, `billing`, `out of budget`, `BudgetExceededError`, `PaymentRequiredError`, `Payment Required`, `exceeded your current quota`, `usage limit`, `subscription_sharing_usage_limit_exceeded`, `subscription_sharing_workplace_individual_usage_limit_exceeded`, `GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`, `available balance`, `"code":"1308"`, `"code":1308`, `使用上限`, the Zhipu/Z.ai codes and wording of "Zhipu/Z.ai account and plan limits", other than Pi's Codex usage-limit message that carries no usable reset time (no reset at all, or ` Try again in ~0 min.`); see "Codex usage limit without a reset time"
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

### Requirement: Provider vocabulary
The classifier SHALL recognise the error wording of every provider API Pi ships (Anthropic, OpenAI Completions/Responses/Codex, Google, Bedrock, Mistral), of common gateways (OpenRouter, LiteLLM proxy including its exception class names, gRPC status names), of subscription usage limits, of Zhipu/Z.ai's documented business codes, and every pattern of Pi's own retryable and non-retryable lists (checked against Pi 1.5). The vocabulary SHALL be kept as reviewable tables with a source note per group.

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
- **WHEN** the error text contains one of `usage limit`, `subscription_sharing_usage_limit_exceeded`, `subscription_sharing_workplace_individual_usage_limit_exceeded`, `GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`, `"code":"1308"`, `"code":1308`, `使用上限`, the Zhipu/Z.ai codes and wording of "Zhipu/Z.ai account and plan limits", other than Pi's Codex usage-limit message that carries no usable reset time (no reset at all, or ` Try again in ~0 min.`); see "Codex usage limit without a reset time"
- **THEN** the category is `quota`

#### Scenario: Codex usage limit without a reset time
- **WHEN** the whole error message (the error text itself, apart from any diagnostics) is Pi's Codex message `You have hit your ChatGPT usage limit.` or `You have hit your ChatGPT usage limit (<plan> plan).`, optionally followed by ` Try again in ~0 min.`. Pi's Codex adapter renders the message for every HTTP 429 with a JSON error body, including a transient `rate_limit_exceeded`, and for any status whose error `code`, or `type` when `code` is absent, contains `usage_limit_reached`, `usage_not_included` or `rate_limit_exceeded`. It adds a reset time only when the body has `resets_at`, and writes `~0 min` when that reset is less than 30 s away or already past.
- **THEN** the category is `rate_limit` and the reason names the matched message. The retry decision then follows the usual rules: with no header, diagnostic or text hint the failure is retried with backoff; an accepted header hint (Codex over SSE) sets the delay; a hint above the acceptance limit or a `nonRetryable` user pattern stops the retry.
- **AND** the same holds when the message carries diagnostics, such as the transport diagnostic Pi attaches after a WebSocket-to-SSE fallback
- **AND** the same message followed by `Try again in ~12 min.` stays `quota` with a 12-minute hint

#### Scenario: ChatGPT usage limit with reset time
- **WHEN** the error text is `You have hit your ChatGPT usage limit (plus). Try again in 12 minutes.`
- **THEN** the category is `quota`, a 12-minute hint is found, and the failure is retryable when the limit is 30 minutes

#### Scenario: Zhipu/Z.ai plan usage limit
- **WHEN** no retry-after hint is accepted, no user pattern matches, and the error text carries code 1308 as a string, with or without a status prefix, as in `429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-10-29 02:54:39 重置。"}` or `{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-10-29 02:54:39 重置。"}`, or as a number, as in `429 {"code":1308,"message":"x"}`, a form taken from Pi's pattern and not observed in a response, or a Pi adapter has rendered the failure without `"code"`, leaving the wording `使用上限`, as in `429 已达到 5 小时的使用上限。您的限额将在 2026-10-29 02:54:39 重置。` or `429 Too Many Requests: 已达到 5 小时的使用上限。您的限额将在 2026-10-29 02:54:39 重置。 (1308)`
- **THEN** the category is `quota`, no hint is read from the reset time in the text, which carries no time zone, and the failure is not retryable, with the reason `quota or billing limit without a reset time`, or the acceptance limit's reason when a hint above that limit is present
- **AND** a 429 that carries a longer code such as `"code":"13080"`, or a transient Zhipu/Z.ai code such as `"code":"1302"`, and no quota wording stays `rate_limit` and retryable

#### Scenario: Zhipu/Z.ai account and plan limits
- **WHEN** no retry-after hint is accepted, no user pattern matches, and the error text carries one of the codes 1113, 1309, 1310, 1313, 1314, 1316, 1317, 1318, 1319, 1320 or 1321, as in `429 {"error":{"code":"1309","message":"…"}}` or `429: {"code":"1309","message":"x"}`, or as a number, a form taken from Pi's pattern and not observed in a response, or the error text has lost the code and carries `账户已欠费`, `套餐已到期`, `套餐已失效`, `公平使用策略`, `insufficient balance`, `plan package has expired`, `enterprise package has expired`, `Weekly/Monthly Limit Exhausted` or `Fair Usage Policy`
- **THEN** the category is `quota` and the failure is not retryable, with the reason `quota or billing limit without a reset time`, or the acceptance limit's reason when a hint above that limit is present
- **AND** no hint is read from a reset time without a time zone, as in `您的限额将在 2026-11-05 02:54:39 重置` or `Resets at 2026-11-05 02:54:39.`

#### Scenario: Zhipu/Z.ai limit with an accepted hint
- **WHEN** the error text is `429 {"code":"1309","message":"Try again in 2s"}` and the accepted limit is 30 minutes
- **THEN** the category is `quota` and the failure is retryable with a 2 s delay

#### Scenario: Zhipu/Z.ai access restrictions
- **WHEN** no user pattern matches, and the error text carries code 1311 or 1315, as a string or a number, or the error text has lost the code and carries `订阅套餐暂未开放`, `仅限企业编程套餐`, `subscription plan does not yet include access` or `API Key is limited to enterprise coding package`
- **THEN** the category is `auth` and the failure is not retryable, although the status is 429, and even with an accepted hint: `429 {"code":"1311","message":"Try again in 2s"}` stops

#### Scenario: Zhipu/Z.ai codes that are not limits
- **WHEN** a 429 carries code 1302 or 1305 or their table wording (`您的账户已达到速率限制`, `该模型当前访问量过大`, `Rate limit reached for requests`, `The service may be temporarily overloaded`), or a code on neither table, such as `"code":"1312"` or `"code":"1322"`, or a longer code that only starts with a listed one, such as `"code":"13090"`, `"code":"11130"`, `"code":"13110"` or `"code":"13150"`, and no quota or access wording
- **THEN** the category is `rate_limit` and the failure is retryable
- **AND** a 500 carrying 1200, 1230 or 1234 with its Chinese table wording is `server_error` and retryable
- **AND** `400 Prompt 超长`, the official table's wording for code 1261, is `invalid_request` and not retryable, while `400 Prompt exceeds max length` and `400 Prompt too long` are context overflow through Pi's patterns

#### Scenario: Pi's lists are covered with documented differences
- **WHEN** an error text matches an entry of Pi 1.5's built-in retryable or non-retryable lists, and no user pattern is configured
- **THEN** the decision follows pi-retry's category, status and hint rules, not Pi's wording-only decision (Pi's overflow check, then `isRetryableAssistantError`). Pi's lists are covered, but the two decisions deliberately differ, as in these examples:
  - `quota exceeded`: Pi stops; here `rate_limit`, retried, because Google's per-minute `Quota exceeded for quota metric` resets.
  - A Gemini 429 that says `billing` and `Quota exceeded` and carries `"retryDelay": "33s"`: Pi stops; here `quota` with an accepted hint, retried.
  - `Server requested 3600s retry delay (max: 60s)`: Pi retries; here not retried, because the hint is above the acceptance limit.
  - `400 Provider returned error`: Pi retries; here `invalid_request`, not retried. The same holds when the 400 is captured or comes from diagnostics.
  - `503 model not found`: Pi retries; here `not_found`, not retried.
  - `429 You exceeded your current quota.`: Pi retries; here `quota` without a hint, not retried.
  - `500 litellm.ContextWindowExceededError`: Pi retries; here `context_overflow`, not retried. The prose form `Context Window exceeded`, which LiteLLM's pre-call check adds to the class name, is context overflow for Pi 1.5 too: Pi compacts the context and re-sends.
  - `429: Too many tokens per minute`: Pi treats it as context overflow, compacts the context and re-sends; here `rate_limit`, retried after a wait.
  - `429 已达到 5 小时的使用上限。…`, with no `"code"` in the text: Pi retries, because its 1308 entry needs `"code"`; here `quota` without a hint, not retried.
  - `429 {"code":"1309",…}` and the other Zhipu/Z.ai codes of "Zhipu/Z.ai account and plan limits" and "Zhipu/Z.ai access restrictions": Pi retries, because only 1308 is on its list; here `quota` without a hint, or `auth`, not retried.
- **AND** these agree with Pi: `429 insufficient_quota` and `429: {"code":"1308",…}` stop (`quota` without a hint), and OpenAI's `429 … invalid_request_error … rate_limit_exceeded` is retried (`rate_limit`)
- **AND** Pi recognises 429, 500, 502, 503, 504, 520 and 524 wherever no letter or digit touches the number; here a number counts only in a status position

#### Scenario: Google per-minute quota
- **WHEN** the error text is `429 Quota exceeded for quota metric 'Generate requests per minute'`
- **THEN** the category is `rate_limit` and the failure is retryable

#### Scenario: Billing quota
- **WHEN** the error text is `You exceeded your current quota, please check your plan and billing details` with no hint
- **THEN** the category is `quota` and the failure is not retryable
