# Spec Delta

## Purpose

The `/retry` command, user-facing reporting during retries, and the extension's behaviour next to Pi's own retry and queued messages.

## ADDED Requirements

### Requirement: Command
The extension SHALL register a `/retry` command. Without arguments it SHALL print the effective configuration, whether the extension is enabled for the session, and the current attempt state (idle, or waiting with attempt, remaining time and reason). `/retry cancel` ends a wait without retrying and aborts the run; `/retry off` disables the extension for the session and cancels any wait the same way; `/retry on` re-enables it. Any other argument SHALL print the usage.

#### Scenario: Status while idle
- **WHEN** the user runs `/retry` and no wait is in progress
- **THEN** the output lists `enabled`, `maxRetries`, `baseDelayMs`, `maxBackoffMs`, `maxRetryAfterMs`, the number of user patterns, `headerHints: on` or `headerHints: off (<reason>)`, and `state: idle`

#### Scenario: Status while waiting
- **WHEN** the user runs `/retry` during a wait
- **THEN** the output includes `state: waiting`, the attempt out of `maxRetries`, the remaining seconds and the classification reason

#### Scenario: Off then on
- **WHEN** the user runs `/retry off` and later `/retry on`
- **THEN** failures in between are not retried and failures afterwards are

### Requirement: Reporting
The extension SHALL report through `ctx.ui.notify` with fixed strings and severities, and through a status-line entry under the key `pi-retry` that counts down every second during a wait and clears when it ends. The `pi-retry` custom session entry is the machine-readable record in every mode.

#### Scenario: Notification strings
- **WHEN** the extension reports
- **THEN** it uses exactly: `pi-retry: <category> (<reason>); retry <attempt>/<max> in <duration>` (info) when a wait starts; `pi-retry: not retrying: <reason>` (warning) for a non-retryable failure; `pi-retry: giving up after <max> retries: <reason>` (warning) when the budget is exhausted; `pi-retry: succeeded on retry <attempt>` (info) on success; `pi-retry: retry cancelled` (info) on cancel, Escape, or shutdown; `pi-retry: Pi's built-in retry is enabled and runs first; set "retry": { "enabled": false } in Pi settings to let pi-retry govern every attempt` (info) for the layering notice

#### Scenario: Status line during the wait
- **WHEN** a 30 s wait starts for attempt 2 of 10
- **THEN** the status line shows `retry 2/10 in 30s` and counts down to `retry 2/10 in 1s` before clearing

#### Scenario: RPC mode
- **WHEN** Pi runs in RPC mode and a retry is scheduled
- **THEN** the retry proceeds and the notification is forwarded through the RPC extension UI channel

#### Scenario: JSON or print mode
- **WHEN** Pi runs in JSON or print mode and a retry is scheduled
- **THEN** the retry proceeds, no notification is delivered, and the `pi-retry` custom entry appears in the session event stream

### Requirement: Coexistence with Pi's retry
The extension SHALL read Pi's `retry.enabled` setting at session start and, when it is not explicitly `false` (the setting is absent at its default), notify once (info) that Pi's built-in retry runs first, that Pi renews its budget before every pi-retry continuation, and that `"retry": { "enabled": false }` is required for pi-retry's classification and timing to govern every attempt. The extension SHALL NOT change Pi's settings.

#### Scenario: Pi retry enabled
- **WHEN** a session starts with Pi's `retry.enabled` at its default (true)
- **THEN** one info notification explains the layering and nothing else changes

#### Scenario: Pi retry disabled
- **WHEN** `retry.enabled` is false
- **THEN** no notification about layering is shown

### Requirement: Queued messages
A user message queued while the extension waits SHALL end a backoff wait early and SHALL be delivered with the retry; during a wait that honours an accepted provider hint it SHALL be delivered with the retry at the deadline (see retry-scheduling "Cancellable wait").

#### Scenario: Steer during a backoff wait
- **WHEN** the user types a message while `retry 1/10 in 45s` (backoff) is shown
- **THEN** the retry is sent at once and the message is part of the retried run

#### Scenario: Steer during a provider deadline
- **WHEN** the user types a message while a 300 s hinted wait is shown
- **THEN** the countdown continues and the message is part of the run sent at the deadline
