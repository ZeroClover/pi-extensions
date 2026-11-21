# Spec Delta

## MODIFIED Requirements

### Requirement: Cancellable wait
The wait SHALL be cancellable, SHALL end early on a queued user message only when it is a backoff wait (a provider-hinted wait keeps its deadline and delivers the message with the retry), and SHALL be observed at least every second so the status line stays current.

#### Scenario: Cancel sources
- **WHEN** `/retry cancel` or `/retry off` is run or Escape is pressed in the terminal during a wait
- **THEN** the wait ends without retrying, the handler returns no drafts, and a run abort is requested through `ctx.abort()` so Pi neither continues on queued messages nor sends the retry

#### Scenario: Cancel
- **WHEN** a 60 s wait is in progress and the user runs `/retry cancel`
- **THEN** the wait ends within one second, the run is aborted, no retry is sent, the failure remains the last message, nothing is appended to the session, and a notification says the retry was cancelled

#### Scenario: Cancel with a queued message during a provider deadline
- **WHEN** a 300 s hinted wait is in progress, the user has queued a message, and then runs `/retry cancel`
- **THEN** the run is aborted, no request is sent before the deadline or after it, and Pi's abort handling applies to the queued message

#### Scenario: Queued message during backoff
- **WHEN** a 60 s backoff wait is in progress and the user submits a message
- **THEN** the wait ends within one second and the retry is sent together with the queued message

#### Scenario: Queued message during a provider deadline
- **WHEN** a 300 s wait from an accepted `retry-after` hint is in progress and the user submits a message after 1 s
- **THEN** the wait continues, the status line shows the remaining time, and the retry with the queued message is sent after the full 300 s

#### Scenario: Escape in the terminal
- **WHEN** the user presses Escape during the wait in interactive mode
- **THEN** the wait ends within one second, no retry is sent, nothing is appended to the session, and a notification says the retry was cancelled

#### Scenario: Abort from a non-terminal client
- **WHEN** an RPC client sends `abort` during the wait
- **THEN** the wait continues until it ends or is cancelled; afterwards Pi discards the continuation and the `pi-retry` entry records the attempt as cancelled

#### Scenario: Session shutdown
- **WHEN** a `session_shutdown` event is delivered during the wait
- **THEN** the wait ends at once and no retry is sent
- **AND** Pi 1.6 delivers the event only after a wait has ended (see "Quitting Pi during the wait")

#### Scenario: Quitting Pi during the wait
- **WHEN** Pi starts aborting the run for shutdown during the wait (interactive Ctrl+D, a double Ctrl+C or `/quit`, SIGTERM or, off Windows, SIGHUP, an RPC client closing its input, or an SDK runtime dispose)
- **THEN** Pi aborts the run and waits for it to settle before it delivers `session_shutdown` (since Pi 1.5.1), so the wait runs to its end before Pi exits; no retry is sent, and the `pi-retry` entry records the attempt as cancelled, as for an RPC `abort`
- **AND** Ctrl+D, a double Ctrl+C and `/quit` first drain terminal input, then close the interactive screen before the abort; if the countdown expires during the drain, the retry can start before Pi aborts
- **AND** in print, JSON and RPC modes a second handled signal exits at once, before the wait ends; no retry is sent and no `pi-retry` entry is recorded for that attempt
- **AND** cancelling first (Escape or `/retry cancel`) lets Pi exit at once

#### Scenario: Session switch or fork
- **WHEN** `session_before_switch` or `session_before_fork` fires during the wait
- **THEN** the wait ends before Pi awaits the run abort, so the switch is not delayed, and no retry is sent

#### Scenario: Reload command during the wait
- **WHEN** the user runs the built-in `/reload`, or an extension command calls `ctx.reload()` or an SDK host calls `AgentSession.reload()`, during the wait
- **THEN** Pi refuses it because the session is busy, and the wait continues; the user cancels the wait first and then reloads
