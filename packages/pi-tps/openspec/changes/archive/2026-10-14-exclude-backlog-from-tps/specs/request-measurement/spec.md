## MODIFIED Requirements

### Requirement: Live output TPS over a sliding window
While streaming, live TPS SHALL be the generation rate over the most recent 5 s: each delta's calibrated tokens are attributed to the interval since the previous delta of the same phase, intervals are clipped to the window and the tokens prorated by the clipped share, and the rate is the summed tokens over the summed counted intervals. An interval SHALL NOT count (neither tokens nor time) when it is the first of a phase, spans a phase change, or is an output stall; a thinking interval counts whatever its length. A delta that starts a phase or ends an output stall SHALL open a backlog window covering the 300 ms after its arrival: no time inside it counts, and an interval reaching into it is clipped to the part after it and its tokens prorated like at the window edge. The window SHALL NOT move with later deltas. The time since the last delta SHALL count, outside any backlog window, while it is under 500 ms. Live TPS SHALL be unavailable until 1.5 s of counted time exist. While a thinking phase that has streamed a delta is open, live TPS SHALL instead be the request's calibrated thinking tokens over its thinking time so far, unavailable until that time reaches 1.5 s.

#### Scenario: Early in the stream
- **WHEN** the first output delta arrived 0.8 s ago
- **THEN** live TPS is unavailable and the readout shows a placeholder

#### Scenario: First chunk is large
- **WHEN** the first output delta carries 40 tokens, then 10 tokens arrive every 250 ms
- **THEN** live TPS is unavailable before 1.8 s after the first delta and 40 tokens per second whenever a delta has just arrived from then on, never higher at the start

#### Scenario: Backlog over several reads
- **WHEN** the first output delta is followed within 100 ms by four deltas carrying 200 tokens, and from 200 ms on 10 tokens arrive every 100 ms
- **THEN** none of the 200 tokens is counted, live TPS is unavailable before 1.8 s after the first delta and 100 tokens per second whenever a delta has just arrived from then on

#### Scenario: Window shorter than 5 s
- **WHEN** 3 s have passed since the first output delta and the deltas after it carried 5 tokens every 100 ms
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

#### Scenario: Flush after a stall
- **WHEN** output at 50 tokens per second pauses for 2 s and resumes with 150 tokens within 100 ms, then continues at 50 tokens per second
- **THEN** the 150 tokens are not counted and live TPS stays 50 tokens per second

#### Scenario: Long pause
- **WHEN** output at 60 tokens per second stops, and the pause has lasted 3.6 s
- **THEN** the window holds 1.4 s of counted time and live TPS is unavailable; it was 60 until the pause reached 3.5 s and stays unavailable until deltas resume

#### Scenario: Resuming after a pause
- **WHEN** continuous output resumes after a 3 s pause
- **THEN** the window holds 2 s of pre-pause output when output resumes; the resumed output's first 300 ms count neither tokens nor time while pre-pause time keeps leaving the window, so the counted time falls to 1.7 s, then stays there as resumed time replaces pre-pause time, and live TPS stays available throughout; after a 4 s pause the counted time falls from 1 s to 0.7 s, stays there until the pre-pause output has left the window and then grows with the resumed output, so the figure returns after 1.8 s of resumed output

#### Scenario: Thinking phase
- **WHEN** a thinking phase of a model with thinking ratio 8 opens at 0 s and streams summary chunks of 20 estimated tokens at 1, 2, 3 and 4 s
- **THEN** live TPS is unavailable before 1.5 s and 160 tokens per second at 4 s

#### Scenario: Silence between summary chunks
- **WHEN** a thinking phase of a model with thinking ratio 8 opens at 0 s, streams chunks of 20 estimated tokens at 1 s and 2 s and nothing more until 8 s
- **THEN** live TPS is 40 tokens per second at 8 s rather than falling to 0

#### Scenario: Hidden thinking phase
- **WHEN** a thinking phase is open and has streamed no delta
- **THEN** live TPS is unavailable and the readout shows the phase's duration

### Requirement: Settlement from provider usage
At `message_end`, when `usage.output` is a finite positive number, the settled TPS SHALL be the request's generated tokens over its generation time. With an observed thinking phase, generated tokens SHALL be `usage.output` and the generation time the thinking time plus the active output span. Without one, the output SHALL be counted by the live window's rules over the whole request (first delta of a phase, stalls and backlog windows excluded): generated tokens SHALL be `usage.output` minus the reported reasoning tokens, times the counted share of the arriving output estimate, and the generation time the counted output time; both SHALL be 0 when the arriving estimate is 0. The record SHALL carry both. Thinking tokens SHALL be `usage.reasoning` when positive, else the calibrated thinking estimate when thinking was streamed. Without `usage.output` the figures SHALL use the calibrated estimates and be marked estimated. A generation time under 1 s SHALL yield no settled TPS.

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
- **WHEN** usage reports output 1210 and reasoning 900, no thinking phase was observed, and 10 estimated output tokens arrive every 100 ms from the first output delta at 0 s to 3.0 s
- **THEN** the counted output is 270 of the 310 arriving estimated tokens over 2.7 s, generated tokens are 310 × 270 / 310 = 270, settled TPS is 100, thinking tokens are 900 without a duration, the record's output tokens stay 1210, and the figure is not marked estimated

#### Scenario: No thinking
- **WHEN** usage reports output 610 and reasoning 0, no thinking phase was observed, and 10 estimated output tokens arrive every 100 ms from the first output delta at 0 s to 6.0 s
- **THEN** the counted output is 570 of 610 arriving estimated tokens over 5.7 s, generated tokens are 570, settled TPS is 100 and there are no thinking tokens

#### Scenario: Backlog without thinking
- **WHEN** no thinking phase was observed, usage reports output 600, the first output delta carries 100 estimated tokens and 10 estimated tokens follow every 100 ms until 5.0 s
- **THEN** the counted output is 470 of the 600 arriving estimated tokens over 4.7 s, generated tokens are 470 and settled TPS is 100, where all 600 tokens over the 5 s output span would give 120

#### Scenario: No arriving estimate
- **WHEN** usage reports output 100, no thinking phase was observed, and five whitespace-only output deltas whose estimates add nothing arrive 400 ms apart
- **THEN** generated tokens and generation time are 0, the request has no settled TPS, and its record is valid

#### Scenario: Inconsistent usage
- **WHEN** usage reports reasoning 500 for output 300, or a negative or non-finite count
- **THEN** reasoning is capped at the output and invalid counts are treated as 0

#### Scenario: Very short response
- **WHEN** the thinking time is 0.3 s and the active output span is 0.4 s
- **THEN** the request has no settled TPS of its own and does not contribute to the model's TPS average; its tokens still count toward the session totals

#### Scenario: Thinking-heavy tool call
- **WHEN** the thinking time is 3 s and the active output span is 0.4 s
- **THEN** the request has a settled TPS over 3.4 s and contributes to the model's TPS average

#### Scenario: Backlog after thinking
- **WHEN** usage reports output 1000, the thinking time is 6 s, and 60 % of the output arrives within 100 ms of the first text delta before the rest streams over 2 s
- **THEN** settled TPS is 1000 over 8.1 s of thinking time and active output span, the backlog's tokens counting because their generation time lies in the thinking time

### Requirement: Burst detection
Output deltas (text and tool-call) less than 1 ms after the previous output delta SHALL form one arrival batch (one network read); thinking deltas are a summary or a chain of thought at the provider's cadence and SHALL NOT be burst evidence. A request SHALL be marked as burst delivery when any criterion holds: fewer than 5 output batches for a response of at least 50 output-stream tokens, where that count is, in order of precedence, `usage.output` minus a positive `usage.reasoning` (with or without a thinking phase), `usage.output` alone when no thinking phase was observed and no positive reasoning was reported, and the calibrated estimate of the output stream otherwise; a 100 ms window carrying at least 50 % of the arriving output tokens (the positive part of each delta's estimate; estimator corrections are not arrivals), where the window's tokens leave out the output deltas inside the backlog window that opens each output phase (its first output delta and those at most 300 ms after it) and the total does not, while the output stream (first to last output delta) lasts more than 1 s; or a settled generation TPS above 10 000.

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

#### Scenario: Backlog when the answer starts
- **WHEN** a thinking phase closes, 400 of 650 estimated output tokens arrive in 20 deltas within 100 ms of the first text delta, and the remaining 250 stream in 25 deltas over the following 2 s
- **THEN** the request is not marked burst, because the cluster criterion's windows leave out the first 300 ms of the output phase while its total keeps all 650 tokens

#### Scenario: Several short output phases
- **WHEN** two output phases separated by 2 s of thinking each receive 10 tokens at 0, 100, 200, 300 and 400 ms after their first output delta
- **THEN** the request is not marked burst: outside the phase-opening backlog windows only the deltas at 400 ms remain, so the largest window carries 10 of the 100 arriving tokens

#### Scenario: Flush after normal streaming
- **WHEN** an output phase streams 100 tokens evenly over 1 s, stalls for 6 s and then 300 tokens arrive within 50 ms
- **THEN** the request is marked burst by the cluster criterion, because only the backlog window that opens a phase is left out
