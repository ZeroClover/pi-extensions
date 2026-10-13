# request-measurement Specification

## Purpose

Measures agent runs and the timing and generation rate of each assistant API request inside them: time to first token, thinking and output phases, live and settled tokens-per-second, stalls, and burst delivery.

## Requirements

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
TTFT SHALL be the duration from the request start to the first `message_update` whose assistant event is a `text_delta`, `thinking_delta` or `toolcall_delta` with a non-empty delta, except that when the first such delta is a `thinking_delta` and its thinking block was opened by a `thinking_start` event, TTFT SHALL be the duration to that `thinking_start`. Other events without content (`text_start`, `toolcall_start`, empty deltas, `start`) SHALL NOT end the wait, and a `thinking_start` whose block never streams a non-empty delta SHALL NOT end it either.

#### Scenario: Thinking arrives first
- **WHEN** `thinking_start` arrives 1.1 s after the request and the first non-empty `thinking_delta` 1.3 s after the request
- **THEN** TTFT is 1.1 s, and the live readout shows 1.3 s counting up until that delta arrives and 1.1 s from then on

#### Scenario: Thinking block without deltas
- **WHEN** `thinking_start` arrives at 0.5 s, `thinking_end` at 8.0 s without any thinking delta, and the first `text_delta` at 8.2 s
- **THEN** TTFT is 8.2 s

#### Scenario: Empty start events
- **WHEN** `text_start` arrives 0.4 s after the request and the first non-empty `text_delta` arrives at 0.9 s
- **THEN** TTFT is 0.9 s

### Requirement: Time to first visible text
The measurement SHALL also record the duration from request start to the first non-empty `text_delta` or `toolcall_delta` as a secondary metric, available in telemetry even when it is not displayed.

#### Scenario: Thinking precedes text
- **WHEN** thinking deltas arrive from 1.0 s and the first text delta arrives at 6.0 s
- **THEN** TTFT is 1.0 s and time to first visible text is 6.0 s

### Requirement: Thinking and output are measured separately
Thinking SHALL be measured as phases delimited by the provider's events: a phase opens at `thinking_start` (or at the first non-empty `thinking_delta` when no start event preceded it) and closes at `thinking_end` (or at the first following non-thinking event, or at the end of the request). The thinking time of a request SHALL be the summed wall time of its phases, silence included; thinking before the earliest exposed boundary is TTFT and SHALL NOT be guessed. Output deltas (text and tool-call) SHALL be accumulated into their own token estimate and active span as before. A request SHALL record whether its thinking was `none`, `hidden` (a phase without non-empty deltas) or `streamed`.

#### Scenario: Mixed thinking and output
- **WHEN** a request streams 4 s of thinking followed by 2 s of text
- **THEN** thinking time is 4 s, thinking TPS uses only thinking tokens over the thinking time, and output TPS uses only output tokens over the output span

#### Scenario: Summary in chunks
- **WHEN** a thinking phase opens at 1 s, streams summary chunks at 2 s, 6 s and 11 s, and closes at 12 s
- **THEN** thinking time is 11 s, no stall is recorded, and the thinking is `streamed`

#### Scenario: Hidden reasoning
- **WHEN** `thinking_start` arrives at 0.5 s and `thinking_end` at 8.0 s with no thinking delta in between
- **THEN** thinking time is 7.5 s and the thinking is `hidden`

#### Scenario: Start synthesised from the first chunk
- **WHEN** `thinking_start` and the first summary chunk arrive together at 6.0 s, further chunks follow, and the phase closes at 12.0 s
- **THEN** thinking time is 6.0 s, TTFT is 6.0 s, and the record carries no marker for the unobserved thinking before 6.0 s

#### Scenario: Several thinking phases
- **WHEN** a request streams thinking for 3 s, a tool call, thinking for 2 s and text
- **THEN** thinking time is 5 s

#### Scenario: Phase without end event
- **WHEN** thinking deltas arrive without a `thinking_start` from 1.0 s to 4.0 s and the first `text_delta` arrives at 4.5 s with no `thinking_end`
- **THEN** thinking time is 3.5 s (first thinking delta to the first text delta)

#### Scenario: No thinking
- **WHEN** a request streams only text
- **THEN** thinking time, thinking tokens and thinking TPS are absent (not zero) and the thinking is `none`

### Requirement: Live output TPS over a sliding window
While streaming, live TPS SHALL be the generation rate over the most recent 5 s: each delta's calibrated tokens are attributed to the interval since the previous delta of the same phase, intervals are clipped to the window and the tokens prorated by the clipped share, and the rate is the summed tokens over the summed counted intervals. An interval SHALL NOT count (neither tokens nor time) when it is the first of a phase, spans a phase change, or is an output stall; a thinking interval counts whatever its length. The time since the last delta SHALL count when it is thinking time or output time under 500 ms. Live TPS SHALL be unavailable until 1.5 s of counted time exist.

#### Scenario: Early in the stream
- **WHEN** the first output delta arrived 0.8 s ago
- **THEN** live TPS is unavailable and the readout shows a placeholder

#### Scenario: First chunk is large
- **WHEN** the first output delta carries 40 tokens, then 10 tokens arrive every 250 ms
- **THEN** live TPS is 40 tokens per second from 1.5 s on, not higher at the start

#### Scenario: Window shorter than 5 s
- **WHEN** 3 s have passed since the first output delta and 150 tokens arrived in deltas after it
- **THEN** live TPS is 50 tokens per second

#### Scenario: Window at full length
- **WHEN** 20 s have passed and the deltas arriving in the last 5 s carry 400 tokens
- **THEN** live TPS is 80 tokens per second

#### Scenario: Delta straddling the window edge
- **WHEN** a delta of 30 tokens closes a 1 s interval of which 0.4 s lie inside the window
- **THEN** that delta contributes 12 tokens and 0.4 s

#### Scenario: Stall inside the window
- **WHEN** the last 5 s hold 3 s of output deltas at 60 tokens per second and a 2 s pause
- **THEN** live TPS is 60 tokens per second

#### Scenario: Long pause
- **WHEN** output at 60 tokens per second stops, and the pause has lasted 3.6 s
- **THEN** the window holds 1.4 s of counted time and live TPS is unavailable; it was 60 until the pause reached 3.5 s and stays unavailable until deltas resume

#### Scenario: Resuming after a pause
- **WHEN** continuous output resumes after a 3 s pause
- **THEN** the window holds 2 s of pre-pause output when output resumes and, as resumed output accrues, loses pre-pause time at the same rate, so the counted time stays at 2 s and live TPS stays available throughout; after a 4 s pause the counted time stays at 1 s until the pre-pause output has left the window and then grows with the resumed output, so the figure returns after 1.5 s of resumed output, the resumed output's first delta counting neither tokens nor time

#### Scenario: Thinking phase
- **WHEN** a model with thinking ratio 8 streams summary chunks of 20 estimated tokens every second
- **THEN** live TPS is 160 tokens per second during the thinking phase

#### Scenario: Hidden thinking phase
- **WHEN** a thinking phase is open and has streamed no delta
- **THEN** live TPS is unavailable and the readout shows the phase's duration

### Requirement: Stall detection
A gap of 500 ms or more between two consecutive output deltas of the same request SHALL be recorded as a stall; consecutive stalled deltas count as one stall event. Stall time SHALL be excluded from the active output span. Gaps before the first delta, gaps inside a thinking phase, gaps around a phase change and gaps between messages SHALL NOT count as stalls.

#### Scenario: Server pause mid-stream
- **WHEN** text deltas arrive continuously, then nothing for 1.2 s, then continue
- **THEN** one stall of 1.2 s is recorded and the active output span excludes 1.2 s

#### Scenario: Gap before first token
- **WHEN** 3 s pass between request start and the first delta
- **THEN** no stall is recorded (the gap is TTFT)

#### Scenario: Silence while thinking
- **WHEN** 4 s pass between two thinking deltas of one phase
- **THEN** no stall is recorded and the 4 s are thinking time

### Requirement: Settlement from provider usage
At `message_end`, when `usage.output` is a finite positive number, the settled TPS SHALL be the request's generated tokens over its generation time (thinking time plus active output span). Generated tokens SHALL be `usage.output` when a thinking phase was observed, else `usage.output` minus the reported reasoning tokens; the record SHALL carry them. Thinking tokens SHALL be `usage.reasoning` when positive, else the calibrated thinking estimate when thinking was streamed. Without `usage.output` the figures SHALL use the calibrated estimates and be marked estimated. A generation time under 1 s SHALL yield no settled TPS.

#### Scenario: Provider reports reasoning tokens
- **WHEN** usage reports output 1200 and reasoning 400, the thinking time is 5 s and the active output span is 10 s
- **THEN** settled TPS is 80, generated tokens are 1200, thinking tokens are 400 and visible output is 800

#### Scenario: Provider reports no reasoning breakdown
- **WHEN** usage reports output 1200 and reasoning 0, thinking was streamed and estimated at 350 tokens after calibration, the thinking time is 5 s and the active output span is 10 s
- **THEN** settled TPS is 80, thinking tokens are 350 marked estimated, and visible output is 850

#### Scenario: Hidden thinking with reasoning count
- **WHEN** usage reports output 1200 and reasoning 900, a thinking phase without deltas lasted 20 s and the active output span is 3 s
- **THEN** settled TPS is 1200 / 23 ≈ 52.2 and thinking tokens are 900

#### Scenario: Reasoning count without a thinking phase
- **WHEN** usage reports output 1200 and reasoning 900 and no thinking phase was observed, with an active output span of 3 s
- **THEN** generated tokens are 300, settled TPS is 300 / 3 = 100, thinking tokens are 900 without a duration, the record's output tokens stay 1200, and the figure is not marked estimated

#### Scenario: No thinking
- **WHEN** usage reports output 600 and reasoning 0, no thinking phase was observed and the active output span is 6 s
- **THEN** settled TPS is 100 and there are no thinking tokens

#### Scenario: Inconsistent usage
- **WHEN** usage reports reasoning 500 for output 300, or a negative or non-finite count
- **THEN** reasoning is capped at the output and invalid counts are treated as 0

#### Scenario: Very short response
- **WHEN** the thinking time is 0.3 s and the active output span is 0.4 s
- **THEN** the request has no settled TPS of its own and does not contribute to the run TPS; its tokens still count toward the sums

#### Scenario: Thinking-heavy tool call
- **WHEN** the thinking time is 3 s and the active output span is 0.4 s
- **THEN** the request has a settled TPS over 3.4 s and contributes to the run TPS

### Requirement: Burst detection
Output deltas (text and tool-call) less than 1 ms after the previous output delta SHALL form one arrival batch (one network read); thinking deltas are a summary or a chain of thought at the provider's cadence and SHALL NOT be burst evidence. A request SHALL be marked as burst delivery when any criterion holds: fewer than 5 output batches for a response of at least 50 output-stream tokens, where that count is, in order of precedence, `usage.output` minus a positive `usage.reasoning` (with or without a thinking phase), `usage.output` alone when no thinking phase was observed and no positive reasoning was reported, and the calibrated estimate of the output stream otherwise; a 100 ms window carrying at least 50 % of the arriving output tokens (the positive part of each delta's estimate; estimator corrections are not arrivals) while the output stream (first to last output delta) lasts more than 1 s; or a settled generation TPS above 10 000.

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
- **WHEN** the settled generation TPS is 25 000
- **THEN** the request is marked burst

#### Scenario: Hidden reasoning then a short tool call
- **WHEN** usage reports output 940 and reasoning 900 after a thinking phase without deltas, and the 40 visible tokens arrived in 3 deltas
- **THEN** the request is not marked burst, because only 40 output tokens arrived

#### Scenario: Reasoning count without a phase, short answer
- **WHEN** usage reports output 940 and reasoning 900, no thinking phase was observed, and the 40 visible tokens arrived in 3 batches
- **THEN** the request is not marked burst, because the threshold count is 940 − 900 = 40

#### Scenario: Short tool call after unreported thinking
- **WHEN** usage reports output 624 and reasoning 0 after streamed thinking estimated at 500 tokens, and a tool call estimated at 20 tokens arrived in one batch
- **THEN** the request is not marked burst, because the threshold uses the output stream's 20 tokens rather than the residual 124

#### Scenario: Chunked summary then a tool call
- **WHEN** summary chunks of 20 estimated tokens arrive at 2 s, 6 s and 11 s and a 20-token tool call at 12 s, with usage output 1500 and reasoning 1480
- **THEN** the request is not marked burst, its rate is 1500 over the 10 s thinking phase plus the output span, it contributes to the run TPS and it updates the thinking ratio

#### Scenario: Summary delivered in one piece
- **WHEN** one summary chunk of 300 estimated tokens arrives at 8 s and 200 visible tokens then stream in 80 deltas over 4 s
- **THEN** the request is not marked burst

#### Scenario: Buffered chain of thought and answer
- **WHEN** 2000 tokens of thinking and 400 visible tokens arrive together in 4 deltas 15 s after the request
- **THEN** the request is marked burst by the batch criterion and reports throughput

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

#### Scenario: Estimator correction at the end
- **WHEN** `123456`, `789012`, `345678`, `90` and `n` arrive 300 ms apart and the last delta lowers the running estimate
- **THEN** the request is not marked burst

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
