# Spec Delta

## Purpose

Extracts the wait a provider asks for from headers, diagnostics and error text, normalises it to a delay, and decides whether that wait is acceptable.

## ADDED Requirements

### Requirement: Header hints
When HTTP headers are available for the failed request, a hint SHALL be read from the standard and provider-specific rate-limit headers in a fixed precedence; the first header that yields a usable value wins. `retry-after-ms` and `retry-after` are consulted for every error status; the window-reset headers are consulted only when the status is 429.

#### Scenario: Precedence
- **WHEN** several hint headers are present
- **THEN** they are consulted in the order `retry-after-ms` (milliseconds), `retry-after` (seconds or HTTP-date), `x-ratelimit-reset-requests` then `x-ratelimit-reset-tokens` (OpenAI durations such as `6m0s`, `1.5s`, `250ms`), `anthropic-ratelimit-*-reset` (RFC 3339, the latest wins), `x-ratelimit-reset`, `ratelimit-reset` (seconds, or an epoch in seconds or milliseconds)

#### Scenario: Window-reset header on a non-429
- **WHEN** the headers of a 503 response contain `x-ratelimit-reset-requests: 6m0s` and no retry-after
- **THEN** no header hint is produced

#### Scenario: Retry-After seconds
- **WHEN** the headers contain `retry-after: 20`
- **THEN** the hint is 20 000 ms with source `header retry-after`

#### Scenario: Retry-After date
- **WHEN** the headers contain `retry-after: Wed, 21 Oct 2026 07:28:00 GMT` and the current time is 07:27:30 GMT on that day
- **THEN** the hint is 30 000 ms

#### Scenario: OpenAI reset duration
- **WHEN** the headers contain `x-ratelimit-reset-requests: 6m0s` and no retry-after
- **THEN** the hint is 360 000 ms

#### Scenario: Epoch reset
- **WHEN** the headers contain `x-ratelimit-reset: 1760000100` and the current time is epoch second 1 760 000 040
- **THEN** the hint is 60 000 ms

### Requirement: Text hints
When no header or diagnostic hint exists, a hint SHALL be read from the error text using a fixed set of recognised forms covering the providers Pi ships and common gateway wording.

#### Scenario: Recognised forms
- **WHEN** the error text contains one of: OpenAI `try again in 1.2s` / `in 6m0s` / `in 250ms`; Google `"retryDelay": "28s"` or `retryDelay: 28s`; Pi's `Server requested 90s retry delay` (seconds, rounded up by Pi); Pi's Codex adapter `Try again in ~12 min.` (optional plan text, `~`, `min`, trailing punctuation); generic `retry after 30 seconds`, `retry-after: 30`, `resets in 5 minutes`, `resets at <ISO 8601 or epoch>`, or a `reset_at` / `resets_at` JSON field with an epoch value
- **THEN** the corresponding delay is produced with source `text <form>`

#### Scenario: OpenAI message
- **WHEN** the error text is `Rate limit reached for gpt-4o ... Please try again in 1.284s.`
- **THEN** the hint is 1 284 ms with source `text try again in`

#### Scenario: Google RetryInfo
- **WHEN** the error text contains `{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"28s"}`
- **THEN** the hint is 28 000 ms

#### Scenario: Codex usage-limit message
- **WHEN** the error text is `You have hit your ChatGPT usage limit (plus plan). Try again in ~12 min.`
- **THEN** the hint is 720 000 ms with source `text try again in`

#### Scenario: Codex usage-limit rounded to zero
- **WHEN** the error text ends with `Try again in ~0 min.`
- **THEN** no hint is produced and the quota policy applies

#### Scenario: Pi provider-retry cap message
- **WHEN** the error text is `Server requested 90s retry delay (max: 60s). 429 rate_limit_error`
- **THEN** the hint is 90 000 ms

#### Scenario: Reset timestamp
- **WHEN** the error text contains `"resets_at": 1760000100` and the current time is epoch second 1 760 000 040
- **THEN** the hint is 60 000 ms

### Requirement: Diagnostic hints
When the assistant message carries diagnostics whose details include a retry delay (`retryAfterMs`, `retryAfter`, `retryDelay`) the value SHALL be used with the same unit rules as the equivalent header, ranking after header hints and before text hints.

#### Scenario: Diagnostic delay
- **WHEN** a diagnostic has details `{ "status": 429, "retryAfter": "15" }` and there are no headers
- **THEN** the hint is 15 000 ms with source `diagnostic retryAfter`

### Requirement: Hint normalisation
A hint SHALL be normalised to a non-negative delay in milliseconds measured from the moment of extraction. Absolute times in the past, zero, negative values and unparsable values SHALL yield no hint. Epoch values above 10^12 are milliseconds, above 10^9 are seconds, otherwise a relative duration in seconds.

#### Scenario: Reset in the past
- **WHEN** `retry-after` is an HTTP-date 10 s before now
- **THEN** no hint is produced and backoff applies

#### Scenario: Garbage value
- **WHEN** `retry-after` is `soon`
- **THEN** no hint is produced and backoff applies

### Requirement: Acceptance limit
A hint SHALL be compared with `maxRetryAfterMs`. A hint within the limit is honoured exactly (plus a fixed 250 ms grace). A hint above the limit SHALL make the failure non-retryable with the reason `provider asked to wait <duration>, limit is <duration>`, regardless of category and regardless of user-defined patterns (see error-classification "Final decision precedence").

#### Scenario: Hint inside the limit
- **WHEN** the hint is 90 s and `maxRetryAfterMs` is 1 800 000
- **THEN** the retry delay is 90 250 ms

#### Scenario: Hint above the limit
- **WHEN** the hint is 2 h and `maxRetryAfterMs` is 1 800 000
- **THEN** no retry is scheduled and the user is told the provider asked for 2 h against a 30 min limit

#### Scenario: Limit disabled
- **WHEN** `maxRetryAfterMs` is 0
- **THEN** any hint is honoured

### Requirement: Header capture gate
Header hints from `after_provider_response` SHALL be used only when the extension can prove that one foreground request produced exactly one response event; otherwise header hints are off, diagnostics and text apply, and `/retry` shows the gate state with its reason.

#### Scenario: Gate conditions
- **WHEN** the gate is evaluated for a failure
- **THEN** it is open only if Pi's `cacheWarming` setting is `off`, no `cache_warming_decision` event has fired in the session, Pi's `retry.provider.maxRetries` is 0, and the failed message's API is not `openai-codex-responses`

#### Scenario: Gate open
- **WHEN** `cacheWarming` is `off`, `retry.provider.maxRetries` is 0, the failed message's API is `mistral-conversations`, and the window holds one capture with status 429 and `retry-after: 45`
- **THEN** the 45 s hint is used

#### Scenario: Warming enabled
- **WHEN** `cacheWarming` is `streaming` (Pi's default) or a `cache_warming_decision` event has fired in the session
- **THEN** no header capture is used for the rest of the session and the failure falls back to diagnostics and text

#### Scenario: Provider-level retries enabled
- **WHEN** `retry.provider.maxRetries` is 2 and the window holds a 429 capture followed by a 200 capture before a mid-stream failure
- **THEN** no header capture is used

#### Scenario: Codex adapter
- **WHEN** the failed message's API is `openai-codex-responses` and the window holds a 429 capture
- **THEN** no header capture is used; the Codex text hint applies if present

### Requirement: Response capture window
When the gate is open, the capture SHALL be the response event received between the failed request's `context` event and its assistant `message_end`; a window with no capture, more than one capture, or a capture with status below 400 yields no header hint. Captures are bound by this window, never by message object identity.

#### Scenario: Single error capture
- **WHEN** the window holds exactly one capture and its status is 503 with `retry-after: 10`
- **THEN** the hint is 10 000 ms

#### Scenario: Stale capture
- **WHEN** a request fails and only the previous request's response, whose assistant message has ended, carried `retry-after: 30`
- **THEN** the earlier header is not used for the new failure

#### Scenario: Unexpected second capture
- **WHEN** two response events arrive in one window although the gate is open
- **THEN** no header hint is used and the gate is closed for the rest of the session
