# Spec Delta

## MODIFIED Requirements

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
- **THEN** the request has no settled TPS of its own and does not contribute to the model's TPS average; its tokens still count toward the session totals

#### Scenario: Thinking-heavy tool call
- **WHEN** the thinking time is 3 s and the active output span is 0.4 s
- **THEN** the request has a settled TPS over 3.4 s and contributes to the model's TPS average

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
- **THEN** the request is not marked burst, its rate is 1500 over the 10 s thinking phase plus the output span, it contributes to the model's TPS average and it updates the thinking ratio

#### Scenario: Summary delivered in one piece
- **WHEN** one summary chunk of 300 estimated tokens arrives at 8 s and 200 visible tokens then stream in 80 deltas over 4 s
- **THEN** the request is not marked burst

#### Scenario: Buffered chain of thought and answer
- **WHEN** 2000 tokens of thinking and 400 visible tokens arrive together in 4 deltas 15 s after the request
- **THEN** the request is marked burst by the batch criterion and reports throughput

### Requirement: Burst requests do not feed calibration or TPS aggregates
Telemetry from a burst request SHALL be excluded from calibration updates and from the model's TPS average. Its throughput SHALL feed the model's burst throughput average, its TTFT the model's TTFT average, and its tokens and cost the session totals.

#### Scenario: Burst request ends
- **WHEN** a burst request settles with 900 output tokens and cost 0.01
- **THEN** the session totals include its tokens and cost, the model's TPS average is unchanged and its burst throughput average includes the request

### Requirement: Aborted requests
When the user aborts a request, the measurement SHALL produce a partial record marked aborted, from the data observed so far. It SHALL NOT feed calibration or any average; its tokens and cost SHALL count toward the session totals.

#### Scenario: Escape during streaming
- **WHEN** the user presses Escape 5 s into streaming
- **THEN** the run settles as aborted, the idle readout starts with `✗`, the session totals include the partial tokens, and the model's averages are unchanged
