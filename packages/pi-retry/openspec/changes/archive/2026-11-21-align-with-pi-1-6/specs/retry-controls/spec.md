# Spec Delta

## MODIFIED Requirements

### Requirement: Reporting
The extension SHALL report through `ctx.ui.notify` with fixed strings and severities, and through a status-line entry under the key `pi-retry` that counts down every second during a wait and clears when it ends. The `pi-retry` custom session entry is the machine-readable record in every mode.

#### Scenario: Notification strings
- **WHEN** the extension reports
- **THEN** it uses exactly: `pi-retry: <category> (<reason>); retry <attempt>/<max> in <duration>` (info) when a wait starts; `pi-retry: not retrying: <reason>` (warning) for a non-retryable failure; `pi-retry: giving up after <max> retries: <reason>` (warning) when the budget is exhausted; `pi-retry: succeeded on retry <attempt>` (info) on success; `pi-retry: retry cancelled` (info) on cancel, Escape, session switch, or a `session_shutdown` delivered during the wait, which Pi 1.6 does not do (see retry-scheduling, "Quitting Pi during the wait"); `pi-retry: Pi's built-in retry is enabled and runs first; set "retry": { "enabled": false } in Pi settings to let pi-retry govern every attempt` (info) for the layering notice

#### Scenario: Status line during the wait
- **WHEN** a 30 s wait starts for attempt 2 of 10
- **THEN** the status line shows `retry 2/10 in 30s` and counts down to `retry 2/10 in 1s` before clearing

#### Scenario: RPC mode
- **WHEN** Pi runs in RPC mode and a retry is scheduled
- **THEN** the retry proceeds and the notification is forwarded through the RPC extension UI channel

#### Scenario: JSON or print mode
- **WHEN** Pi runs in JSON or print mode and a retry is scheduled
- **THEN** the retry proceeds, no notification is delivered, and the `pi-retry` custom entry appears in the session event stream
