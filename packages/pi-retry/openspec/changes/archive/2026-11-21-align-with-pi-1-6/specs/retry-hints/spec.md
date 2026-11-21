# Spec Delta

## MODIFIED Requirements

### Requirement: Header capture gate
Header hints from `after_provider_response` SHALL be used only when the extension can prove that one foreground request produced exactly one response event; otherwise header hints are off, diagnostics and text apply, and `/retry` shows the gate state with its reason. An adapter that retries inside one request regardless of Pi's settings SHALL be excluded by its API, so that its several response events never close the gate for other requests.

#### Scenario: Gate conditions
- **WHEN** the gate is evaluated for a failure
- **THEN** it is open only if Pi's `cacheWarming` setting is `off`, no `cache_warming_decision` event has fired in the session, Pi's `retry.provider.maxRetries` is 0, and the failed message's API is not `bedrock-converse-stream`

#### Scenario: Gate open
- **WHEN** `cacheWarming` is `off`, `retry.provider.maxRetries` is 0, the failed message's API is `mistral-conversations`, and the window holds one capture with status 429 and `retry-after: 45`
- **THEN** the 45 s hint is used

#### Scenario: Warming enabled
- **WHEN** `cacheWarming` is `idle` (Pi's default) or `streaming`
- **THEN** no header capture is used while the setting stays so, and the failure falls back to diagnostics and text

#### Scenario: Warming decision
- **WHEN** a `cache_warming_decision` event has fired in the session
- **THEN** no header capture is used for the rest of the session, whatever `cacheWarming` is set to afterwards, and the failure falls back to diagnostics and text

#### Scenario: Provider-level retries enabled
- **WHEN** `retry.provider.maxRetries` is 2 and the window holds a 429 capture followed by a 200 capture before a mid-stream failure
- **THEN** no header capture is used

#### Scenario: Bedrock adapter
- **WHEN** the gate conditions on Pi's settings hold, the failed message's API is `bedrock-converse-stream`, and the window holds two 429 captures with `retry-after: 1`, as the AWS SDK's own retry and its final attempt produce
- **THEN** no header capture is used for this failure, the gate is not closed for the session, and a later failure on another adapter with one 429 capture and `retry-after: 1` still gets the 1 s header hint

#### Scenario: Codex adapter
- **WHEN** the gate conditions on Pi's settings hold, the failed message's API is `openai-codex-responses`, its error text is Pi's Codex message `You have hit your ChatGPT usage limit.`, and the window holds one capture with status 429 and `retry-after: 1`
- **THEN** the category is `rate_limit` and the 1 s header hint is used
