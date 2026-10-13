# tps-readout Specification

## Purpose

Presents the measurement as a compact footer readout in the interactive TUI: live figures while a request streams, run progress while tools execute, a run summary once the agent run has settled, colour by speed, and the commands that control it.

## Requirements

### Requirement: Readout lives in the footer status area
The readout SHALL be written through `ctx.ui.setStatus` under a single key so that it shares the footer line with other extensions and never occupies its own line.

#### Scenario: Another extension sets a status
- **WHEN** another extension also calls `setStatus`
- **THEN** both texts appear on the footer line and neither is overwritten

### Requirement: Label styles
The readout SHALL support two label styles selected by the configuration key `labels`: `text` (default), which names every field with a short word and separates fields with ` · `, and `symbols`, which marks every field with a single-cell symbol and separates fields with a space. Both styles SHALL show the same fields in the same order.

#### Scenario: Default style
- **WHEN** no `labels` key is configured and a run has settled
- **THEN** the readout reads like `TPS 110.5 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%) · out 1.4K · req 3`

#### Scenario: Symbol style
- **WHEN** `labels` is `"symbols"` and the same run has settled
- **THEN** the readout reads like `✓ »110.5/s ⇥0.7s 18.4s ↑6.2K ↻92% ↓1.4K ×3`

### Requirement: Symbol set
The symbol style SHALL mark every field with one single-cell, non-emoji symbol, the same for every phase, and the README SHALL document them.

#### Scenario: Every field in the symbol style
- **WHEN** `labels` is `"symbols"`
- **THEN** each field uses the symbol of this table, and the text style uses the label:

| Field | Text label | Symbol |
|---|---|---|
| Output TPS | `TPS 48.6 tok/s` | `»48.6/s` |
| Burst throughput | `burst 225.0 tok/s` | `↯225.0/s` |
| TTFT | `TTFT 1.2s` | `⇥1.2s` |
| Elapsed time | bare duration `18.4s` (`run 12.3s` while working) | bare duration `18.4s` |
| Input tokens, cache folded in | `in 6.2K` | `↑6.2K` |
| Cache share of input | `(cache 92%)` after the input | `↻92%` |
| Visible output tokens (output minus thinking) | `out 1.4K` | `↓1.4K` |
| Thinking tokens and duration | `think 94 4.1s` | `✻94 4.1s` |
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

### Requirement: Readout phases
The readout SHALL have five phases: idle (no run active), waiting (request sent, no token yet), streaming (deltas arriving), working (run active between requests) and the idle summary. Waiting and streaming SHALL show the request number when the run has more than one request; working SHALL show no rate.

#### Scenario: Waiting
- **WHEN** a request has been sent and no delta has arrived
- **THEN** the readout shows `⠋ TTFT 1.2s` with the TTFT counting up

#### Scenario: Streaming
- **WHEN** deltas of the second request of a run are arriving
- **THEN** the readout shows `⠙ TPS 48.6 tok/s · TTFT 1.2s · out 1.2K · think 1.9K 4.0s · req 2`

#### Scenario: Working between requests
- **WHEN** the first request of a run ended with tool calls and the tools are executing
- **THEN** the readout shows `⠹ run 12.3s · req 1 · out 1.6K` and no TPS

### Requirement: Summary only after the run settles
The readout SHALL NOT show a per-request summary. The run summary SHALL be shown once the run has settled (`agent_settled`), with the run TPS, mean TTFT, elapsed time, input tokens with cache share, output tokens, thinking tokens and duration, stall time and count, request count and cost, each only when available.

#### Scenario: Multi-request run
- **WHEN** a run makes three requests separated by tool executions
- **THEN** no summary appears after the first or second request, and the summary of all three appears when the run settles

#### Scenario: Burst-only run
- **WHEN** every request of a settled run was burst delivery
- **THEN** the TPS field is replaced by the burst throughput `burst 225.0 tok/s` (`↯225.0/s`)

#### Scenario: Aborted run
- **WHEN** the user presses Escape during a run
- **THEN** the summary of the requests observed so far is shown with the aborted marker

### Requirement: Number formatting
Token counts below 1000 SHALL be integers; larger counts SHALL use `K`, `M` or `B` with one decimal, dropping a trailing `.0`. Durations below one minute SHALL show one decimal and a `s` suffix; longer durations SHALL show the two largest units without decimals (`1m 30s`, `2h 15m`). TPS SHALL show one decimal. Cost SHALL show two decimals from $1, three from $0.01 and four below.

#### Scenario: Large token counts
- **WHEN** input tokens are 12 345 and output tokens are 987
- **THEN** the readout shows `in 12.3K` and `out 987`

#### Scenario: Round thousands
- **WHEN** input tokens are 40 000
- **THEN** the readout shows `in 40K`

#### Scenario: Cached input
- **WHEN** usage reports input 200, cacheRead 8 000 and cacheWrite 0
- **THEN** the input field shows `in 8.2K (cache 98%)`

### Requirement: TPS colour from thresholds
The output TPS figure (live, run and session) SHALL be coloured according to the highest threshold whose minimum is not greater than the value, resolved from the configuration for the provider and model that produced it. Burst throughput and every other field SHALL use the configured base colour.

#### Scenario: Value between thresholds
- **WHEN** thresholds are 0→error, 30→warning, 80→success and TPS is 45
- **THEN** the TPS figure is rendered in the `warning` colour

#### Scenario: Value below the lowest threshold
- **WHEN** the lowest threshold minimum is 10 and TPS is 4
- **THEN** the TPS figure uses the base colour

### Requirement: Animation driven by one throttled ticker
While a run is active the readout SHALL be refreshed by a single timer at the configured interval (default 100 ms) that advances the spinner and re-renders the numbers; delta events SHALL update state only and SHALL NOT trigger a render. The timer SHALL stop when the run settles or the session shuts down.

#### Scenario: High delta rate
- **WHEN** 500 deltas arrive within one second
- **THEN** the footer is re-rendered about 10 times in that second

#### Scenario: Idle
- **WHEN** no run is active
- **THEN** no timer is running

### Requirement: Animation can be disabled
When animation is disabled in the configuration the readout SHALL show a static indicator and refresh only when a displayed value changes.

#### Scenario: Animation off
- **WHEN** `animation.enabled` is false and a request streams
- **THEN** the indicator does not rotate and renders happen only on value changes, at most once per interval

### Requirement: Idle display follows the summary mode
When idle, the readout SHALL show the last run summary in `last` mode or the session average in `session` mode. With no data in the selected mode it SHALL show the TPS and TTFT fields with `—`.

#### Scenario: Session mode after three runs
- **WHEN** the mode is `session` and three runs have settled
- **THEN** the idle readout shows the session TPS, mean TTFT, summed tokens, summed cost and `runs 3` with the session marker

#### Scenario: No data
- **WHEN** no run has settled on the current branch
- **THEN** the idle readout shows `TPS — · TTFT —`

### Requirement: /tps command toggles visibility
`/tps` SHALL toggle the readout between shown and hidden; measurement, persistence and event broadcasts continue while hidden. Visibility lasts until the extension runtime is replaced (`/reload`, session switch), which restores the configured `enabled` value.

#### Scenario: Hide
- **WHEN** the user runs `/tps` while the readout is shown
- **THEN** the status text is cleared and the next run is still measured and persisted

### Requirement: /tps mode command switches the summary mode
`/tps mode` SHALL toggle between `last` and `session`; `/tps mode last` and `/tps mode session` SHALL set the mode explicitly, and the readout SHALL re-render immediately. The mode lasts until the extension runtime is replaced (`/reload`, session switch), which restores the configured `summaryMode`.

#### Scenario: Explicit mode
- **WHEN** the user runs `/tps mode session`
- **THEN** the idle readout switches to the session average at once

### Requirement: Non-TUI modes write nothing to the UI
In `rpc`, `json` and `print` modes the extension SHALL measure, persist and broadcast but SHALL NOT call `setStatus` or emit ANSI sequences.

#### Scenario: RPC client
- **WHEN** Pi runs in RPC mode
- **THEN** telemetry events are emitted and no status text is sent
