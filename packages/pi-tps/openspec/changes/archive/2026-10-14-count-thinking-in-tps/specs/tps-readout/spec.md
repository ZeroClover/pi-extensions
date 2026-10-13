# Spec Delta

## MODIFIED Requirements

### Requirement: Symbol set
The symbol style SHALL mark every field with one single-cell, non-emoji symbol, the same for every phase, and the README SHALL document them.

#### Scenario: Every field in the symbol style
- **WHEN** `labels` is `"symbols"`
- **THEN** each field uses the symbol of this table, and the text style uses the label:

| Field | Text label | Symbol |
|---|---|---|
| Generation TPS (thinking and output) | `TPS 48.6 tok/s` | `»48.6/s` |
| Burst throughput | `burst 225.0 tok/s` | `↯225.0/s` |
| TTFT | `TTFT 1.2s` | `⇥1.2s` |
| Elapsed time | bare duration `18.4s` (`run 12.3s` while working) | bare duration `18.4s` |
| Input tokens, cache folded in | `in 6.2K` | `↑6.2K` |
| Cache share of input | `(cache 92%)` after the input | `↻92%` |
| Visible output tokens (output minus thinking) | `out 1.4K` | `↓1.4K` |
| Thinking tokens and duration (duration only while a hidden phase has no count) | `think 94 4.1s`, `think 4.1s` | `✻94 4.1s`, `✻4.1s` |
| Stall time and count | `stall 1.2s×1` | `‖1.2s×1` |
| Requests in the run / runs in the session | `req 3` / `runs 3` | `×3` |
| Cost | `$0.0018` | `$0.0018` |
| Completed run | no marker | `✓` |
| Aborted run | `aborted` | `✗` |
| Session average | `session` | `Σ` |
| No data | no marker | `·` |
| Estimate not calibrated or summary relying on the estimate | `~` before the number | `~` before the number |
| Unknown value | `—` | `—` |

#### Scenario: Uncalibrated live figure
- **WHEN** the active model has no calibration ratio and live TPS is 48.6
- **THEN** the text style shows `TPS ~48.6 tok/s · TTFT 1.2s · out ~1.2K` and the symbol style `»~48.6/s ⇥1.2s ↓~1.2K`

#### Scenario: Uncalibrated warm-up
- **WHEN** the active model has no calibration ratio and live TPS is not yet available
- **THEN** the estimated counts still carry the marker: `TPS — · TTFT 0.7s · out ~10 · think ~30`

#### Scenario: Estimated summary
- **WHEN** a burst-only run's output tokens come from the estimate because the provider reported no usage
- **THEN** the summary shows `burst ~225.0 tok/s` and `out ~900`; a TPS is marked only when a request contributing to it relied on the estimate, and token counts only when a record behind them did

#### Scenario: Hidden thinking in progress
- **WHEN** a thinking phase without deltas has been open for 4.0 s
- **THEN** the text style shows `TPS — · TTFT 4.2s · think 4.0s` with both durations counting up, and the symbol style `»— ⇥4.2s ✻4.0s`

### Requirement: Readout phases
The readout SHALL have five phases: idle (no run active), waiting (request sent, no thinking phase and no token yet), streaming (a thinking phase is open or deltas are arriving), working (run active between requests) and the idle summary. Waiting and streaming SHALL show the request number when the run has more than one request; working SHALL show no rate. While streaming, the TPS SHALL be the live generation rate, shown during thinking phases that stream deltas.

#### Scenario: Waiting
- **WHEN** a request has been sent and no delta has arrived
- **THEN** the readout shows `⠋ TTFT 1.2s` with the TTFT counting up

#### Scenario: Streaming
- **WHEN** deltas of the second request of a run are arriving
- **THEN** the readout shows `⠙ TPS 48.6 tok/s · TTFT 1.2s · out 1.2K · think 1.9K 4.0s · req 2`

#### Scenario: Streaming a thinking summary
- **WHEN** a thinking phase has streamed summary chunks for 4 s and the model's thinking ratio is known
- **THEN** the readout shows a TPS figure, `out 0` and `think 1.9K 4.0s`, the think count being the calibrated estimate

#### Scenario: Working between requests
- **WHEN** the first request of a run ended with tool calls and the tools are executing
- **THEN** the readout shows `⠹ run 12.3s · req 1 · out 1.6K` and no TPS

### Requirement: Summary only after the run settles
The readout SHALL NOT show a per-request summary. The run summary SHALL be shown once the run has settled (`agent_settled`), with the run's generation TPS (thinking and output tokens over generation time), mean TTFT, elapsed time, input tokens with cache share, visible output tokens, thinking tokens and duration, stall time and count, request count and cost, each only when available.

#### Scenario: Multi-request run
- **WHEN** a run makes three requests separated by tool executions
- **THEN** no summary appears after the first or second request, and the summary of all three appears when the run settles

#### Scenario: Thinking model
- **WHEN** a run's only request reported 1200 output tokens of which 400 reasoning, over 5 s of thinking and 10 s of output
- **THEN** the summary shows `TPS 80.0 tok/s`, `out 800` and `think 400 5.0s`

#### Scenario: Reasoning count without a phase
- **WHEN** a run's only request reported 900 reasoning tokens and no thinking phase was observed
- **THEN** the summary shows `think 900` without a duration and the TPS rests on the visible output

#### Scenario: Burst-only run
- **WHEN** every request of a settled run was burst delivery
- **THEN** the TPS field is replaced by the burst throughput `burst 225.0 tok/s` (`↯225.0/s`)

#### Scenario: Aborted run
- **WHEN** the user presses Escape during a run
- **THEN** the summary of the requests observed so far is shown with the aborted marker
