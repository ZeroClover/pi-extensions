# Spec Delta

## MODIFIED Requirements

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
- **WHEN** the error text is Pi's Codex message ending with `Try again in ~0 min.`, which Pi renders when the reset is less than 30 s away or already past
- **THEN** no hint is produced, and the message is treated like a Codex usage limit without a reset time: `rate_limit`, retried with backoff (see error-classification "Codex usage limit without a reset time")

#### Scenario: Pi provider-retry cap message
- **WHEN** the error text is `Server requested 90s retry delay (max: 60s). 429 rate_limit_error`
- **THEN** the hint is 90 000 ms

#### Scenario: Reset timestamp
- **WHEN** the error text contains `"resets_at": 1760000100` and the current time is epoch second 1 760 000 040
- **THEN** the hint is 60 000 ms

### Requirement: Header capture gate
Header hints from `after_provider_response` SHALL be used only when the extension can prove that one foreground request produced exactly one response event; otherwise header hints are off, diagnostics and text apply, and `/retry` shows the gate state with its reason. An adapter that retries inside one request regardless of Pi's settings SHALL be excluded by its API, so that its several response events never close the gate for other requests.

#### Scenario: Gate conditions
- **WHEN** the gate is evaluated for a failure
- **THEN** it is open only if Pi's `cacheWarming` setting is `off`, no `cache_warming_decision` event has fired in the session, Pi's `retry.provider.maxRetries` is 0, and the failed message's API is not `bedrock-converse-stream`

#### Scenario: Gate open
- **WHEN** `cacheWarming` is `off`, `retry.provider.maxRetries` is 0, the failed message's API is `mistral-conversations`, and the window holds one capture with status 429 and `retry-after: 45`
- **THEN** the 45 s hint is used

#### Scenario: Warming enabled
- **WHEN** `cacheWarming` is `streaming` (Pi's default) or a `cache_warming_decision` event has fired in the session
- **THEN** no header capture is used for the rest of the session and the failure falls back to diagnostics and text

#### Scenario: Provider-level retries enabled
- **WHEN** `retry.provider.maxRetries` is 2 and the window holds a 429 capture followed by a 200 capture before a mid-stream failure
- **THEN** no header capture is used

#### Scenario: Bedrock adapter
- **WHEN** the gate conditions on Pi's settings hold, the failed message's API is `bedrock-converse-stream`, and the window holds two 429 captures with `retry-after: 1`, as the AWS SDK's own retry and its final attempt produce
- **THEN** no header capture is used for this failure, the gate is not closed for the session, and a later failure on another adapter with one 429 capture and `retry-after: 1` still gets the 1 s header hint

#### Scenario: Codex adapter
- **WHEN** the gate conditions on Pi's settings hold, the failed message's API is `openai-codex-responses`, its error text is Pi's Codex message `You have hit your ChatGPT usage limit.`, and the window holds one capture with status 429 and `retry-after: 1`
- **THEN** the category is `rate_limit` and the 1 s header hint is used
