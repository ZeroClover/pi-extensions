# Spec Delta

## ADDED Requirements

### Requirement: Fixed field vocabulary
Every field SHALL use one fixed notation, the same in every state, and the README SHALL document it. There SHALL be no alternative label style, no estimate marker and no stall field.

#### Scenario: Notation of every field
- **WHEN** a field is shown
- **THEN** it uses the notation of this table:

| Field | Notation |
|---|---|
| Live TPS with the model's average | `48.6 (x̄52.3) TPS`; `- (x̄52.3) TPS` while the live rate is not available |
| Average TPS alone | `x̄52.3 TPS` |
| Burst throughput average | `↯` directly before the number: `x̄↯225.0 TPS`, `(x̄↯225.0)` |
| Live TTFT with the model's average | `TTFT 1.2s (x̄1.1s)` |
| Average TTFT alone | `TTFT x̄1.1s` |
| Input tokens, cache folded in, and the cache-read share | `↑6.2K ◎92%`; `◎` part omitted without cache reads |
| Visible output tokens | `↓1.4K` |
| Thinking | `⠿1.9K 4.0s` (count and time), `⠿4.0s` (time only, hidden thinking), `⠿2.1K` (session total) |
| Requests | `2➤` |
| Elapsed time of the active run | `run 12.3s` |
| Runs and total run time of the session | `3 runs in 4m 12s`, `1 run in 18.4s` |
| Cost | `$0.050` |
| Outcome of the last run | `✓` (completed) or `✗` (aborted) before the first field |
| Active run | spinner frame before the first field |
| Unknown value | `-` |

#### Scenario: Uncalibrated estimate
- **WHEN** the serving model has no calibration ratio and live TPS is 48.6
- **THEN** the readout shows `48.6` and `↓1.2K` without any marker

#### Scenario: Output paused
- **WHEN** a run's output stalled for 1.2 s
- **THEN** no field shows the stall

### Requirement: Field separator
Fields SHALL be separated by the configured separator, ` | ` by default. Parts within one field SHALL be separated by single spaces.

#### Scenario: Default separator
- **WHEN** no separator is configured and a request streams
- **THEN** the readout reads like `⠼ 68.3 (x̄52.3) TPS | TTFT 0.6s (x̄1.1s) | ↓1.2K`

#### Scenario: Custom separator
- **WHEN** the separator is `" · "`
- **THEN** the same readout reads `⠼ 68.3 (x̄52.3) TPS · TTFT 0.6s (x̄1.1s) · ↓1.2K`

### Requirement: Averages beside live figures
While waiting or streaming, the TPS and TTFT fields SHALL show the live value followed by the serving model's average in parentheses. A metric without an average for that model SHALL omit its parentheses. The averages SHALL NOT include the request in flight.

#### Scenario: Model with averages
- **WHEN** the serving model averages 52.3 tok/s and 1.1 s TTFT and the live figures are 68.3 tok/s and 0.6 s
- **THEN** the readout shows `68.3 (x̄52.3) TPS | TTFT 0.6s (x̄1.1s)`

#### Scenario: First request of a model
- **WHEN** the serving model has no average and the request has waited 1.4 s
- **THEN** the readout shows `⠋ - TPS | TTFT 1.4s`

#### Scenario: Burst average
- **WHEN** the serving model's only average is a burst throughput of 225.0 tok/s and the request waits for its first token
- **THEN** the readout shows `- (x̄↯225.0) TPS`

### Requirement: Working readout
While a run is active between requests, the readout SHALL show the current model's average TPS and TTFT without parentheses, then the run's elapsed time, the number of requests the run has made and their visible output tokens.

#### Scenario: Tools executing after the first request
- **WHEN** the first request of a run produced 1600 visible output tokens, the tools execute 12.3 s after the run started, and the model averages 52.4 tok/s and 1.0 s
- **THEN** the readout shows `⠹ x̄52.4 TPS | TTFT x̄1.0s | run 12.3s | 1➤ | ↓1.6K`

#### Scenario: No average yet
- **WHEN** the same happens for a model without an average
- **THEN** the readout shows `⠹ - TPS | TTFT - | run 12.3s | 1➤ | ↓1.6K`

### Requirement: Idle readout shows session totals
When no run is active, the readout SHALL show the last run's outcome marker, the current model's average TPS and TTFT, then the session totals of every run on the branch: runs with total run time, requests, input with cache share, visible output, thinking tokens and cost, each only when available. Without any run on the branch it SHALL show `- TPS | TTFT -`.

#### Scenario: Three runs
- **WHEN** three runs totalling 4 min 12 s settled with 14 requests, 40 000 input tokens of which 88 % cache reads, 6 200 visible output tokens, 2 100 thinking tokens and $0.050, and the current model averages 52.4 tok/s and 1.0 s
- **THEN** the readout shows `✓ x̄52.4 TPS | TTFT x̄1.0s | 3 runs in 4m 12s | 14➤ | ↑40K ◎88% | ↓6.2K | ⠿2.1K | $0.050`

#### Scenario: Last run aborted
- **WHEN** the user pressed Escape during the last run
- **THEN** the line starts with `✗` and the figures still cover every run on the branch, the aborted one included

#### Scenario: Current model without an average
- **WHEN** the user selected a model that has not served a request on this branch
- **THEN** the readout shows `✓ - TPS | TTFT - | 3 runs in 4m 12s | …` with the session totals unchanged

#### Scenario: Burst-only model
- **WHEN** the current model's requests were all bursts averaging 225.0 tok/s, without cache reads, thinking or price
- **THEN** the readout shows `✓ x̄↯225.0 TPS | TTFT x̄4.0s | 2 runs in 9.1s | 2➤ | ↑6.2K | ↓1.8K`

#### Scenario: No data
- **WHEN** no run has settled on the current branch
- **THEN** the readout shows `- TPS | TTFT -`

### Requirement: Averages follow the current model
While a request is in flight the averages SHALL be those of the model serving it: the selected model until `message_start` names the serving model. Otherwise they SHALL be those of the current model: the selected model, except that when the last request on the branch was sent under the selected model, the model that served it. Selecting a model SHALL update the idle readout at once.

#### Scenario: Model switch while idle
- **WHEN** the user switches from a model averaging 52.3 tok/s to one averaging 26.0 tok/s
- **THEN** the idle readout shows `x̄26.0 TPS` at once

#### Scenario: Virtual model
- **WHEN** the selected virtual model routed the last request to `anthropic/claude-sonnet-4`
- **THEN** the idle readout shows the averages of `anthropic/claude-sonnet-4`

#### Scenario: Resume
- **WHEN** a session is resumed whose last request was sent to and served by `openai/gpt-5`, with no later model selection
- **THEN** the idle readout shows the averages of `openai/gpt-5`

#### Scenario: Selection before reload
- **WHEN** `openai/gpt-5` served the last request, the user then selected `anthropic/claude-sonnet-4` and runs `/reload`
- **THEN** the idle readout shows the averages of `anthropic/claude-sonnet-4`

#### Scenario: Selection while tools execute
- **WHEN** `openai/gpt-5` served a tool-call request, the user selects `anthropic/claude-sonnet-4` while the tools execute, presses Escape before another request, and runs `/reload`
- **THEN** the idle readout shows the averages of `anthropic/claude-sonnet-4`

#### Scenario: Branch navigation
- **WHEN** `anthropic/claude-sonnet-4` is selected and the user navigates with `/tree` to a branch whose last request was sent to `openai/gpt-5`, then runs `/reload`
- **THEN** after the navigation and after the reload the idle readout shows the averages of `anthropic/claude-sonnet-4` computed from that branch's requests

### Requirement: Relative colour mode
In `relative` mode the live TPS SHALL be coloured by its value as a percentage of the serving model's average TPS, and the live TTFT by the average TTFT as a percentage of the live TTFT, each through the metric's relative threshold list. In both modes the live number and the `TPS` label after it, or the `TTFT` label and the live time after it, SHALL share the resolved colour.

#### Scenario: Default bands
- **WHEN** the relative thresholds are the defaults (0 → error, 40 → warning, 75 → success) and the model averages 52.3 tok/s
- **THEN** live TPS 48.6 (93 %) is success, 31.0 (59 %) warning and 18.2 (35 %) error

#### Scenario: TTFT counting up
- **WHEN** the model averages 1.1 s TTFT and the request has waited 0.6 s, then 2.0 s, then 3.4 s
- **THEN** the live TTFT is success (183 %), then warning (55 %), then error (32 %)

#### Scenario: Slow model at its usual speed
- **WHEN** a model averages 26.0 tok/s and the live TPS is 24.1
- **THEN** the live TPS is success, whereas the default absolute thresholds would make it error

### Requirement: Absolute colour mode
In `absolute` mode the live value SHALL be coloured through the metric's absolute threshold list, TPS in tokens per second and TTFT in seconds. Relative mode SHALL use the absolute list for a metric while the serving model has no average for it, and for TPS while that average is a burst throughput.

#### Scenario: Absolute TPS
- **WHEN** the TPS mode is `absolute` with the default thresholds and the live TPS is 48.6
- **THEN** the live TPS is warning

#### Scenario: First request in relative mode
- **WHEN** the TTFT mode is `relative`, the serving model has no average and the request has waited 1.4 s
- **THEN** the live TTFT is coloured by the absolute thresholds and is success under the defaults

### Requirement: Colours of the other elements
Averages, a live figure shown as `-`, a live TTFT while a thinking phase without deltas is open and no content has arrived, every other field and the spinner SHALL use the base colour; separators SHALL use the separator colour; `↯` the burst colour; `✓` the theme's `success` colour and `✗` its `error` colour. A value below the lowest threshold, or an empty threshold list, SHALL use the base colour. No figure of the idle readout is coloured by thresholds.

#### Scenario: Idle line
- **WHEN** a run has settled
- **THEN** only the outcome marker and a `↯` carry colour; the averages and totals use the base colour

#### Scenario: Hidden thinking
- **WHEN** a thinking phase without deltas has been open for 4.0 s and no content has arrived
- **THEN** the readout shows `- (x̄52.3) TPS | TTFT 4.2s (x̄1.1s) | ⠿4.0s` with the live TTFT in the base colour, coloured again once content arrives and the TTFT freezes

#### Scenario: Value below the lowest threshold
- **WHEN** the lowest threshold minimum is 10 and the coloured value is 4
- **THEN** the live figure uses the base colour

## MODIFIED Requirements

### Requirement: Readout phases
The readout SHALL have four phases: idle (no run active), waiting (request sent, no thinking phase and no token yet), streaming (a thinking phase is open or deltas are arriving) and working (run active between requests). Waiting and streaming SHALL show the request number when the run has more than one request; working SHALL show no live rate. While streaming, the TPS SHALL be the live generation rate, shown during thinking phases that stream deltas.

#### Scenario: Waiting
- **WHEN** a request has been sent, no delta has arrived and the model averages 52.3 tok/s and 1.1 s
- **THEN** the readout shows `⠋ - (x̄52.3) TPS | TTFT 1.2s (x̄1.1s)` with the TTFT counting up

#### Scenario: Streaming
- **WHEN** deltas of the second request of a run are arriving
- **THEN** the readout shows `⠙ 48.6 (x̄52.3) TPS | TTFT 1.2s (x̄1.1s) | ↓1.2K | ⠿1.9K 4.0s | 2➤`

#### Scenario: Streaming a thinking summary
- **WHEN** a thinking phase has streamed summary chunks for 4 s and the model's thinking ratio is known
- **THEN** the readout shows a TPS figure, `↓0` and `⠿1.9K 4.0s`, the thinking count being the calibrated estimate

#### Scenario: Working between requests
- **WHEN** the first request of a run ended with tool calls and the tools are executing
- **THEN** the readout shows `⠹ x̄52.4 TPS | TTFT x̄1.0s | run 12.3s | 1➤ | ↓1.6K` and no live rate

### Requirement: Number formatting
Token counts below 1000 SHALL be integers; larger counts SHALL use `K`, `M` or `B` with one decimal, dropping a trailing `.0`. Durations below one minute SHALL show one decimal and a `s` suffix; longer durations SHALL show the two largest units without decimals (`1m 30s`, `2h 15m`). TPS SHALL show one decimal. Cost SHALL show two decimals from $1, three from $0.01 and four below.

#### Scenario: Large token counts
- **WHEN** input tokens are 12 345 and output tokens are 987
- **THEN** the readout shows `↑12.3K` and `↓987`

#### Scenario: Round thousands
- **WHEN** input tokens are 40 000
- **THEN** the readout shows `↑40K`

#### Scenario: Cached input
- **WHEN** usage reports input 200, cacheRead 8 000 and cacheWrite 0
- **THEN** the input field shows `↑8.2K ◎98%`

### Requirement: /tps command toggles visibility
`/tps` SHALL toggle the readout between shown and hidden; measurement, persistence and event broadcasts continue while hidden. Visibility lasts until the extension runtime is replaced (`/reload`, session switch), which restores the configured `enabled` value. The command takes no arguments; any argument SHALL show a usage warning and leave the visibility unchanged.

#### Scenario: Hide
- **WHEN** the user runs `/tps` while the readout is shown
- **THEN** the status text is cleared and the next run is still measured and persisted

#### Scenario: Argument given
- **WHEN** the user runs `/tps mode`
- **THEN** a usage warning is shown and the readout stays as it was

## REMOVED Requirements

### Requirement: Label styles
**Reason**: One fixed vocabulary replaces the `text` and `symbols` styles.
**Migration**: Remove `labels` from `pi-tps.json`; the notation is described by "Fixed field vocabulary".

### Requirement: Symbol set
**Reason**: Superseded by the fixed vocabulary, which no longer has stall, session or uncalibrated markers.
**Migration**: See "Fixed field vocabulary".

### Requirement: Summary only after the run settles
**Reason**: The readout no longer shows the last run's own figures; averages are shown during the run and session totals after it.
**Migration**: See "Averages beside live figures", "Working readout" and "Idle readout shows session totals". Per-run figures remain available on `pi-tps:run`.

### Requirement: TPS colour from thresholds
**Reason**: Replaced by relative and absolute colouring of both TPS and TTFT.
**Migration**: See "Relative colour mode", "Absolute colour mode" and "Colours of the other elements"; move the old `thresholds` list to `tps.absolute`.

### Requirement: Idle display follows the summary mode
**Reason**: The idle readout always shows session totals with the current model's averages.
**Migration**: Remove `summaryMode` from `pi-tps.json`; see "Idle readout shows session totals".

### Requirement: /tps mode command switches the summary mode
**Reason**: There is no summary mode any more.
**Migration**: Use `/tps` to show or hide the readout.
