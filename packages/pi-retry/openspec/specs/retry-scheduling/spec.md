# retry-scheduling Specification

## Purpose
Decides when a failed request is re-sent: the attempt budget, the delay, the cancellable wait, and the continuation that re-sends the request with the failed attempt hidden from the model.

## Requirements

### Requirement: Trigger point
The extension SHALL act at Pi's `agent_before_settle` boundary when the run outcome is `error`, the last message in model context is an assistant message with stop reason `error`, no other extension has already requested a continuation, and the extension is enabled. It acts only after Pi's own retry has declined or exhausted its budget; pi-retry's `maxRetries` counts its own continuations only.

#### Scenario: Pi's retry still active
- **WHEN** Pi's built-in retry is enabled and has budget left for a failure Pi recognises
- **THEN** Pi retries first and the extension does nothing for that attempt

#### Scenario: Both retries enabled
- **WHEN** Pi's retry is enabled with `maxRetries` 3, pi-retry's `maxRetries` is 10 and every request fails with a retryable error
- **THEN** up to 44 model requests are made (11 pi-retry-governed attempts, each followed by up to 3 Pi retries) before pi-retry gives up

#### Scenario: Failure reaches settlement
- **WHEN** a run ends with an error assistant message and Pi does not retry it
- **THEN** the extension classifies the failure and, if retryable, schedules a retry

#### Scenario: Another extension continues
- **WHEN** an earlier `agent_before_settle` handler already returned `continue: true`
- **THEN** the extension does not schedule a retry

### Requirement: Attempt budget
Consecutive retries of one failing request SHALL be counted; the count SHALL reset to zero when an assistant message with a stop reason other than `error` or `aborted` completes (a success), when an aborted assistant message completes (silently, without a success notification), when a run settles as aborted, and when a new user prompt starts a run. When the count has reached `maxRetries` the failure is not retried and the user is told the budget is exhausted.

#### Scenario: Budget exhausted
- **WHEN** `maxRetries` is 3 and three retries have already failed in a row
- **THEN** the fourth failure is not retried and the notification reads `pi-retry: giving up after 3 retries: <reason>`

#### Scenario: Reset on success
- **WHEN** two retries fail, the third succeeds, and a later request fails
- **THEN** the later failure starts again at attempt 1

#### Scenario: Aborted retry is not a success
- **WHEN** a retried request is aborted by the user mid-stream
- **THEN** the counter is reset, no `succeeded on retry` notification is shown

#### Scenario: Reset on new prompt
- **WHEN** the budget is exhausted and the user sends a new prompt
- **THEN** the next failure starts again at attempt 1

### Requirement: Delay without a hint
When the failure is retryable and no accepted hint exists, the delay SHALL be `min(baseDelayMs × 2^(attempt−1), maxBackoffMs)` multiplied by a jitter factor drawn uniformly from [0.75, 1.0], where `attempt` is 1 for the first retry.

#### Scenario: Backoff sequence
- **WHEN** `baseDelayMs` is 2000, `maxBackoffMs` is 60000 and jitter is 1.0
- **THEN** the delays for attempts 1 to 7 are 2 s, 4 s, 8 s, 16 s, 32 s, 60 s, 60 s

### Requirement: Delay with a hint
When an accepted hint exists the delay SHALL be the hint plus 250 ms, without jitter and without the backoff cap.

#### Scenario: Hint beyond the backoff cap
- **WHEN** `maxBackoffMs` is 60000 and the accepted hint is 300 s
- **THEN** the delay is 300.25 s

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

#### Scenario: Session switch or fork
- **WHEN** `session_before_switch` or `session_before_fork` fires during the wait
- **THEN** the wait ends before Pi awaits the run abort, so the switch is not delayed, and no retry is sent

#### Scenario: Reload command during the wait
- **WHEN** the user runs the built-in `/reload` during the wait
- **THEN** Pi refuses it because the session is busy; the user cancels the wait first and then reloads

### Requirement: Continuation
When the wait completes, the extension SHALL return a boundary result that preserves earlier handlers' drafts, hides the failed assistant message from model context while keeping it in the session file, records the attempt, and requests one continuation on the same context plus any queued messages. No retry SHALL be scheduled when an earlier handler already drafted a compaction.

#### Scenario: Boundary result shape
- **WHEN** a retry is sent
- **THEN** the result's entries are `event.entries` followed by a `context_edit` with a null replacement targeting the failed assistant entry and a `pi-retry` custom entry, and `continue` is true

#### Scenario: Compaction drafted by another handler
- **WHEN** `event.entries` already contains a `compaction` draft
- **THEN** the extension returns nothing and schedules no retry

#### Scenario: Failed attempt hidden
- **WHEN** a retry is sent
- **THEN** the failed assistant message is not in the model context of the retried request and is still present in the session file

#### Scenario: Earlier handler drafts survive
- **WHEN** an earlier `agent_before_settle` handler returned a `context_edit` draft without requesting continuation
- **THEN** the retry's boundary result contains that draft before the omission draft and the retried request sees the edited context

#### Scenario: Retry record
- **WHEN** a retry is sent
- **THEN** the session contains a custom entry of type `pi-retry` with the attempt number, category, reason, delay, hint source, provider, model, and outcome (`scheduled`, or `cancelled` when the run then settles as aborted)

### Requirement: Retry of retries
A retried request that fails again SHALL go through the same decision with the attempt count incremented; a retried request that succeeds SHALL end the retry sequence silently apart from a success notification naming the attempt.

#### Scenario: Second failure
- **WHEN** the first retry fails with a retryable error
- **THEN** a second retry is scheduled with attempt 2

#### Scenario: Success after retry
- **WHEN** the second retry produces a normal assistant message
- **THEN** the notification reads `pi-retry: succeeded on retry 2` and the counter is reset
