# Spec Delta

## Purpose

Presents the measurement as a compact footer readout in the interactive TUI: live figures while streaming, settled figures afterwards, colour by speed, and the commands that control it.

## ADDED Requirements

### Requirement: Readout lives in the footer status area
The readout SHALL be written through `ctx.ui.setStatus` under a single key so that it shares the footer line with other extensions and never occupies its own line.

#### Scenario: Another extension sets a status
- **WHEN** another extension also calls `setStatus`
- **THEN** both texts appear on the footer line and neither is overwritten

### Requirement: Readout phases
The readout SHALL have four phases: idle (no request), waiting (request sent, no token yet), streaming (tokens arriving) and settled (request ended). Each phase SHALL show the fields available in that phase and a placeholder for fields not yet known.

#### Scenario: Waiting
- **WHEN** a request has been sent and no delta has arrived
- **THEN** the readout shows the spinner and a counting TTFT

#### Scenario: Streaming
- **WHEN** deltas are arriving
- **THEN** the readout shows the locked TTFT, live output TPS (or a placeholder before it is available), estimated output tokens, and thinking figures when thinking deltas occurred

#### Scenario: Settled
- **WHEN** the request has ended
- **THEN** the readout shows TTFT, settled output TPS, thinking TPS and duration when present, input/output tokens from usage, elapsed time and cost when available

### Requirement: Displayed fields
The readout SHALL contain, when available: TTFT in seconds (one decimal), output TPS (one decimal), thinking TPS and thinking duration, token usage as input/output with cache read and write folded into the input figure and revealed in the detail, elapsed time, and cost in USD. Token counts of 1000 or more SHALL use a `k` or `M` suffix with one decimal.

#### Scenario: Large token counts
- **WHEN** input tokens are 12 345 and output tokens are 987
- **THEN** the readout shows `12.3k` and `987`

#### Scenario: Cached input
- **WHEN** usage reports input 200, cacheRead 8 000 and cacheWrite 0
- **THEN** the input figure shows 8.2k with a cache marker

### Requirement: Markers
The readout SHALL mark a burst request, an aborted request, an uncalibrated estimate, and a session-average mode with distinct single-character markers that are documented in the README.

#### Scenario: Burst request settled
- **WHEN** a request was marked burst
- **THEN** the TPS figure carries the burst marker and is labelled as throughput in the detail

### Requirement: TPS colour from thresholds
The output TPS figure SHALL be coloured according to the highest threshold whose minimum is not greater than the value, resolved from the configuration for the active provider and model. Other fields SHALL use the configured base colour.

#### Scenario: Value between thresholds
- **WHEN** thresholds are 0→error, 30→warning, 80→success and TPS is 45
- **THEN** the TPS figure is rendered in the `warning` colour

#### Scenario: Value below the lowest threshold
- **WHEN** the lowest threshold minimum is 10 and TPS is 4
- **THEN** the TPS figure uses the base colour

### Requirement: Animation driven by one throttled ticker
During waiting and streaming the readout SHALL be refreshed by a single timer at the configured interval (default 100 ms) that advances the spinner and re-renders the numbers; delta events SHALL update state only and SHALL NOT trigger a render. The timer SHALL stop when the request settles, errors, is aborted, or the session shuts down.

#### Scenario: High delta rate
- **WHEN** 500 deltas arrive within one second
- **THEN** the footer is re-rendered about 10 times in that second

#### Scenario: Idle
- **WHEN** no request is active
- **THEN** no timer is running

### Requirement: Animation can be disabled
When animation is disabled in the configuration the readout SHALL show a static indicator and refresh only when a displayed value changes.

#### Scenario: Animation off
- **WHEN** `animation.enabled` is false and a request streams
- **THEN** the indicator does not rotate and renders happen only on value changes, at most once per interval

### Requirement: Idle display follows the summary mode
When idle, the readout SHALL show the last settled request in `last` mode or the session averages in `session` mode, marked accordingly. With no data in the selected mode it SHALL show placeholders.

#### Scenario: Session mode after three requests
- **WHEN** the mode is `session` and three requests have settled
- **THEN** the idle readout shows average TTFT, average TPS, summed tokens, summed cost and the session marker

### Requirement: /tps command toggles visibility
`/tps` SHALL toggle the readout between shown and hidden for the current session; measurement, persistence and event broadcasts continue while hidden.

#### Scenario: Hide
- **WHEN** the user runs `/tps` while the readout is shown
- **THEN** the status text is cleared and the next request is still measured and persisted

### Requirement: /tps mode command switches the summary mode
`/tps mode` SHALL toggle between `last` and `session`; `/tps mode last` and `/tps mode session` SHALL set the mode explicitly. The mode SHALL persist for the session and the readout SHALL re-render immediately.

#### Scenario: Explicit mode
- **WHEN** the user runs `/tps mode session`
- **THEN** the idle readout switches to session averages at once

### Requirement: Non-TUI modes write nothing to the UI
In `rpc`, `json` and `print` modes the extension SHALL measure, persist and broadcast but SHALL NOT call `setStatus` or emit ANSI sequences.

#### Scenario: RPC client
- **WHEN** Pi runs in RPC mode
- **THEN** telemetry events are emitted and no status text is sent
