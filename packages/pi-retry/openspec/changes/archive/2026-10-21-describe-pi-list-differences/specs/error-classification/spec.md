# Spec Delta

## MODIFIED Requirements

### Requirement: Provider vocabulary
The classifier SHALL recognise the error wording of every provider API Pi ships (Anthropic, OpenAI Completions/Responses/Codex, Google, Bedrock, Mistral), of common gateways (OpenRouter, LiteLLM proxy including its exception class names, gRPC status names), of subscription usage limits, and every pattern of Pi's own retryable and non-retryable lists. The vocabulary SHALL be kept as reviewable tables with a source note per group.

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

#### Scenario: Subscription limits
- **WHEN** the error text contains one of `usage limit`, `subscription_sharing_usage_limit_exceeded`, `GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`
- **THEN** the category is `quota`

#### Scenario: ChatGPT usage limit with reset time
- **WHEN** the error text is `You have hit your ChatGPT usage limit (plus). Try again in 12 minutes.`
- **THEN** the category is `quota`, a 12-minute hint is found, and the failure is retryable when the limit is 30 minutes

#### Scenario: Pi's lists are covered with documented differences
- **WHEN** an error text matches an entry of Pi's built-in retryable or non-retryable pattern lists
- **THEN** the retry decision agrees with Pi's `isRetryableAssistantError`, except for plain `quota exceeded` (Pi: non-retryable; here `rate_limit`, because Google's per-minute `Quota exceeded for quota metric` resets) and bare status numbers (Pi: retryable anywhere; here recognised only in status positions); `429 insufficient_quota` agrees with Pi (`quota`, not retryable without a hint)

#### Scenario: Google per-minute quota
- **WHEN** the error text is `429 Quota exceeded for quota metric 'Generate requests per minute'`
- **THEN** the category is `rate_limit` and the failure is retryable

#### Scenario: Billing quota
- **WHEN** the error text is `You exceeded your current quota, please check your plan and billing details` with no hint
- **THEN** the category is `quota` and the failure is not retryable
