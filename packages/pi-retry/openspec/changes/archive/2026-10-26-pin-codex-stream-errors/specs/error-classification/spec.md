# Spec Delta

## ADDED Requirements

### Requirement: Codex stream error events
A Codex error relayed inside the response stream reaches the classifier only as Pi's text `Codex error: <message or code>`, without status, reset time or diagnostics. The classifier SHALL classify that text by its wording: a usage limit SHALL be `quota` and a rate limit SHALL be `rate_limit`, matching the Codex CLI's own retry decision for each.

#### Scenario: Usage limit in the stream
- **WHEN** the error text is `Codex error: The usage limit has been reached`, which Pi renders from a stream `error` event whose error type is `usage_limit_reached`
- **THEN** the category is `quota`, no hint is found, and the failure is not retryable, with the reason `quota or billing limit without a reset time`

#### Scenario: Rate limit in the stream
- **WHEN** the error text is `Codex error: rate_limit_exceeded`, which Pi renders from a stream `error` event whose error code is `rate_limit_exceeded` and that carries no message
- **THEN** the category is `rate_limit` and the failure is retryable with backoff
