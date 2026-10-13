# Spec Delta

## Purpose

Measures agent runs and the timing and generation rate of each assistant API request inside them: time to first token, thinking and output phases, live and settled tokens-per-second, stalls, and burst delivery.

## ADDED Requirements

### Requirement: Measurement uses a monotonic clock
All durations SHALL be derived from a monotonic clock with sub-millisecond resolution; wall-clock time is only recorded as a timestamp for display and persistence.

#### Scenario: System clock changes during a request
- **WHEN** the system wall clock jumps backwards while a request is streaming
- **THEN** TTFT, elapsed time and TPS are unaffected

### Requirement: A run spans one agent run until Pi settles
A run SHALL start at the first `agent_start` after the previous run settled and end at `agent_settled`, so that automatic retries, compaction and queued continuations belong to the same run. The run's elapsed time SHALL be measured on the monotonic clock from its start to `agent_settled`, and the run SHALL be marked aborted when `agent_settled` reports an abort.

#### Scenario: Tool calls
- **WHEN** a prompt leads to three requests separated by tool executions
- **THEN** the three requests belong to one run whose elapsed time covers the tool executions

#### Scenario: Automatic retry after an error
- **WHEN** a request fails, the agent ends, and Pi retries automatically
- **THEN** the retried request belongs to the same run, which ends only when Pi settles

### Requirement: A measurement covers one provider request within a turn
A measurement SHALL start at the `before_provider_request` that occurs while a turn is active and end at the `message_end` of the assistant message of that turn. Provider requests that do not belong to an active agent turn (cache warming, compaction summaries, branch summaries) SHALL be ignored.

#### Scenario: Cache warming while idle
- **WHEN** a cache-warming request is sent while no turn is active
- **THEN** no measurement starts and the readout does not change

#### Scenario: Automatic retry
- **WHEN** the provider request fails and Pi retries within the same turn
- **THEN** the measurement restarts at the last `before_provider_request` and TTFT does not include the failed attempt

#### Scenario: Model call from a tool
- **WHEN** a tool makes its own provider request after the turn's assistant message ended
- **THEN** that request is not measured

#### Scenario: Concurrent request while streaming
- **WHEN** another provider request starts while the turn's stream is already delivering deltas
- **THEN** it is ignored; requests that start between the turn's request and its first stream event cannot be told apart from a retry and restart the measurement

### Requirement: Time to first token
TTFT SHALL be the duration from the request start to the first `message_update` whose assistant event is a `text_delta`, `thinking_delta` or `toolcall_delta` with a non-empty delta. Events without content (`*_start`, empty deltas, `start`) SHALL NOT end the wait.

#### Scenario: Thinking arrives first
- **WHEN** the first non-empty delta is a `thinking_delta` 1.3 s after the request
- **THEN** TTFT is 1.3 s

#### Scenario: Empty start events
- **WHEN** `text_start` arrives 0.4 s after the request and the first non-empty `text_delta` arrives at 0.9 s
- **THEN** TTFT is 0.9 s

### Requirement: Time to first visible text
The measurement SHALL also record the duration from request start to the first non-empty `text_delta` or `toolcall_delta` as a secondary metric, available in telemetry even when it is not displayed.

#### Scenario: Thinking precedes text
- **WHEN** thinking deltas arrive from 1.0 s and the first text delta arrives at 6.0 s
- **THEN** TTFT is 1.0 s and time to first visible text is 6.0 s

### Requirement: Thinking and output are measured separately
Thinking deltas and output deltas (text and tool-call) SHALL be accumulated into separate token estimates and separate active-time spans, so that a thinking TPS, a thinking duration and an output TPS can each be reported.

#### Scenario: Mixed thinking and output
- **WHEN** a request streams 4 s of thinking followed by 2 s of text
- **THEN** thinking duration is 4 s, thinking TPS uses only thinking tokens over the thinking span, and output TPS uses only output tokens over the output span

#### Scenario: No thinking
- **WHEN** a request streams only text
- **THEN** thinking duration, thinking tokens and thinking TPS are absent (not zero)

### Requirement: Live output TPS over a sliding window
While streaming, live output TPS SHALL be the estimated output tokens received in the most recent 5 s window divided by the window span, where the span is the smaller of 5 s and the time since the first output delta. Live TPS SHALL be unavailable until 1.5 s have elapsed since the first output delta.

#### Scenario: Early in the stream
- **WHEN** 0.8 s have elapsed since the first output delta
- **THEN** live TPS is unavailable and the readout shows a placeholder

#### Scenario: Window shorter than 5 s
- **WHEN** 3 s have elapsed since the first output delta and 150 tokens were estimated
- **THEN** live TPS is 50 tokens per second

#### Scenario: Window at full length
- **WHEN** 20 s have elapsed and the last 5 s contain 400 estimated tokens
- **THEN** live TPS is 80 tokens per second

### Requirement: Stall detection
A gap of 500 ms or more between two consecutive content deltas of the same request SHALL be recorded as a stall; consecutive stalled deltas count as one stall event. Stall time SHALL be excluded from the active generation span used for settled TPS. Gaps before the first delta and gaps between messages SHALL NOT count as stalls.

#### Scenario: Server pause mid-stream
- **WHEN** deltas arrive continuously, then nothing for 1.2 s, then continue
- **THEN** one stall of 1.2 s is recorded and the settled TPS denominator excludes 1.2 s

#### Scenario: Gap before first token
- **WHEN** 3 s pass between request start and the first delta
- **THEN** no stall is recorded (the gap is TTFT)

### Requirement: Settlement from provider usage
At `message_end`, when `usage.output` is a finite positive number, settled output TPS SHALL be `(usage.output − thinking tokens) / active output span`, where thinking tokens are `usage.reasoning` when reported and the calibrated thinking estimate otherwise. When `usage.output` is unavailable, the settled TPS SHALL fall back to the calibrated estimate over the same span. A request whose active output span is shorter than 1 s SHALL have no settled TPS.

#### Scenario: Provider reports reasoning tokens
- **WHEN** usage reports output 1200 and reasoning 400 and the active output span is 10 s
- **THEN** settled output TPS is 80

#### Scenario: Provider reports no reasoning breakdown
- **WHEN** usage reports output 1200, no reasoning field, thinking deltas were estimated at 350 tokens after calibration, and the active output span is 10 s
- **THEN** settled output TPS is 85

#### Scenario: Inconsistent usage
- **WHEN** usage reports reasoning 500 for output 300, or a negative or non-finite count
- **THEN** reasoning is capped at the output and invalid counts are treated as 0

#### Scenario: Very short response
- **WHEN** the active output span is 0.4 s
- **THEN** the request has no settled TPS of its own and does not contribute to the run TPS; its tokens still count toward the sums

### Requirement: Burst detection
Content deltas less than 1 ms after the previous one SHALL form one arrival batch (one network read). A request SHALL be marked as burst delivery when any criterion holds: fewer than 5 batches for a response of at least 50 output tokens; a 100 ms window carrying at least 50 % of its estimated tokens while the stream (first to last delta) lasts more than 1 s; or a computed settled TPS above 10 000.

#### Scenario: Too few batches
- **WHEN** a 900-token response arrives as 3 deltas
- **THEN** the request is marked burst

#### Scenario: Short reply
- **WHEN** a 12-token reply arrives as 3 deltas
- **THEN** the request is not marked burst and has no TPS of its own

#### Scenario: Sub-millisecond gaps
- **WHEN** 40 deltas of a 200-token response arrive 0.3 ms apart
- **THEN** they form one arrival batch and the request is marked burst

#### Scenario: Several events per network read
- **WHEN** 300 deltas arrive as 60 batches of 5 events, the batches 50 ms apart and the events within a batch less than 0.1 ms apart
- **THEN** the request is not marked burst

#### Scenario: Implausible rate
- **WHEN** the computed settled TPS is 25 000
- **THEN** the request is marked burst

### Requirement: Burst requests report throughput
A burst request SHALL report throughput, `usage.output / (end − request start)`, in place of generation TPS and SHALL carry a burst flag.

#### Scenario: Successful request without deltas
- **WHEN** a request settles with usage output 120 and no content delta
- **THEN** it is marked burst and reports throughput over its elapsed time

#### Scenario: Whole response in one chunk
- **WHEN** a 900-token response arrives as one delta 4 s after the request
- **THEN** the request is marked burst and its figure is 225 tokens per second throughput

#### Scenario: Proxy flush after a long wait
- **WHEN** 10 small deltas arrive in 2 ms after 6 s of silence following a normal 1 s of streaming
- **THEN** the request is marked burst

#### Scenario: Genuine fast streaming
- **WHEN** 300 deltas arrive with a median gap of 3 ms over 1 s
- **THEN** the request is not marked burst

### Requirement: Burst requests do not feed calibration or TPS aggregates
Telemetry from a burst request SHALL be excluded from calibration updates and from the run and session TPS, while still counting toward tokens and cost.

#### Scenario: Burst request ends
- **WHEN** a burst request settles with 900 output tokens and cost 0.01
- **THEN** run and session tokens and cost include it and run and session TPS do not

### Requirement: Aborted requests
When the user aborts a request, the measurement SHALL produce a partial record marked aborted, from the data observed so far. It SHALL NOT feed calibration; it SHALL count toward the run and session TPS and mean TTFT only when no settled request qualifies, and its tokens and cost SHALL count toward the sums.

#### Scenario: Escape during streaming
- **WHEN** the user presses Escape 5 s into streaming
- **THEN** the run settles as aborted, its summary shows the abort marker with the partial figures, and when the session holds settled requests its TPS and mean TTFT are unchanged by the aborted request

### Requirement: Errored and deferred requests
When the assistant message ends with `stopReason` `error` or `deferred`, the request SHALL produce no record and its live figures SHALL be cleared; the run continues.

#### Scenario: Provider error
- **WHEN** the request ends with a provider error and Pi retries
- **THEN** no record is produced for the failed request and the readout shows the working phase until the retry streams

### Requirement: Elapsed time and cost
Each settled record SHALL include total elapsed time from request start to `message_end`, token counts from usage (input, output, cache read, cache write, reasoning when present), and cost from `usage.cost` only when `usage.cost.total` is greater than zero.

#### Scenario: Model without pricing
- **WHEN** usage.cost is all zeros
- **THEN** the record has no cost and the readout omits the cost field

#### Scenario: Model with pricing
- **WHEN** usage.cost.total is 0.0123
- **THEN** the record carries cost 0.0123
