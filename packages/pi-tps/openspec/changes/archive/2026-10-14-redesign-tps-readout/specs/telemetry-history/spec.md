# Spec Delta

## ADDED Requirements

### Requirement: Per-model averages
The system SHALL keep per serving provider and model a TPS average, a burst throughput average and a TTFT average over the settled requests on the branch in chronological order. A settled non-burst request with at least 1 s of generation time SHALL contribute its generation rate, a settled burst request its throughput, and every settled request its TTFT, each only when positive. Aborted requests SHALL NOT contribute. The record format SHALL stay at version 2.

#### Scenario: Tool call too short to rate
- **WHEN** a model's settled requests are a 10 s answer at 50 tok/s and a tool call with 0.4 s of generation time
- **THEN** the TPS average is 50 and both requests contribute their TTFT

#### Scenario: Aborted request
- **WHEN** the user presses Escape during a request that streamed for 3 s
- **THEN** the request is persisted with its run and the model's averages do not change

#### Scenario: Two models
- **WHEN** the branch holds requests served by `anthropic/claude-sonnet-4` and by `openai/gpt-5`
- **THEN** each model's averages use only its own requests

#### Scenario: Zero sample
- **WHEN** a settled request's first token arrived within 0.5 ms, so its recorded TTFT is 0
- **THEN** the TTFT average ignores it

#### Scenario: Burst and streamed requests
- **WHEN** a model has a burst average and then streams a request with a generation rate
- **THEN** the TPS average exists and the readout shows it instead of the burst average

### Requirement: Averages are smoothed
The first ten samples of an average SHALL form their arithmetic mean. From the eleventh sample on, each sample SHALL first be clamped to the range from a third of to three times the current average and then folded in as `average + 0.1 × (sample − average)`. An average SHALL be updated when its request settles, before the next readout.

#### Scenario: First samples
- **WHEN** a model's first three TPS samples are 40, 50 and 60
- **THEN** its TPS average is 50

#### Scenario: Slow first request
- **WHEN** a model's first TTFT is 30 s and the next nine are 1 s
- **THEN** its TTFT average after ten samples is 3.9 s, the mean of all ten

#### Scenario: Steady state
- **WHEN** a model's TPS average is 50 after 20 samples and the next sample is 60
- **THEN** the average becomes 51

#### Scenario: Outlier
- **WHEN** a model's TTFT average is 1.0 s after 20 samples and the next TTFT is 30 s
- **THEN** the sample is clamped to 3.0 s and the average becomes 1.2 s

#### Scenario: Working readout includes the finished request
- **WHEN** a request settles with tool calls and the tools start executing
- **THEN** the working readout's averages include that request

### Requirement: Session totals
The session totals SHALL be summed over every run record on the branch: the number of runs, their elapsed times, their request records, input tokens with cache reads and writes, cache-read tokens, visible output tokens (output minus thinking), thinking tokens, and the cost of the records that carry one, absent when none does. Aborted runs and requests SHALL be included. The outcome marker SHALL follow the last run's aborted flag.

#### Scenario: Three runs
- **WHEN** the branch holds runs of 60 s, 90 s and 102 s with 4, 7 and 3 requests
- **THEN** the totals show `3 runs in 4m 12s` and `14➤`

#### Scenario: Thinking without a count
- **WHEN** every thinking phase on the branch was hidden and no provider reported reasoning tokens
- **THEN** the totals have no thinking field

### Requirement: Records name the selected model
A request record SHALL carry `requested` (`{ provider, model }`), the model selected when the request was sent, when it differs from the serving `provider` and `model`. A record without it SHALL be read as sent under its serving model. The record version SHALL stay 2.

#### Scenario: Virtual model
- **WHEN** the selected virtual model `router/auto` sends a request that `anthropic/claude-sonnet-4` serves
- **THEN** the record has provider `anthropic`, model `claude-sonnet-4` and `requested` `{ "provider": "router", "model": "auto" }`

#### Scenario: Record written before this change
- **WHEN** a version-2 record without `requested` is read
- **THEN** it is accepted and treated as sent under its serving model

## MODIFIED Requirements

### Requirement: Persistence can be disabled
When the configuration sets `persist` to false, no `pi-tps` entries SHALL be appended; the runs SHALL then live in memory only, start empty on every session start and not follow `/tree` navigation.

#### Scenario: Persistence off
- **WHEN** `persist` is false and three runs settle, then the user runs `/reload`
- **THEN** the session file holds no `pi-tps` entries and the idle readout shows `- TPS | TTFT -` after the reload

### Requirement: Reconstruction on session start and branch change
On `session_start` and `session_tree` the system SHALL rebuild the session totals and the per-model averages from the `pi-tps` entries on the current branch only, replaying the request records in order. With `persist` false neither totals nor averages are rebuilt from entries.

#### Scenario: Resume
- **WHEN** a session with five settled runs is resumed
- **THEN** the idle readout shows the totals of the five runs and the averages they produce, as before the restart

#### Scenario: Branch switch
- **WHEN** the user navigates with `/tree` to a branch holding two runs
- **THEN** the session totals and the averages reflect those two runs only

### Requirement: Status snapshots are broadcast
Every readout state change, and every ticker refresh while a run is active, SHALL be emitted on the event bus channel `pi-tps:status` with a snapshot of phase `waiting`, `streaming`, `working` or `idle`. Live and working snapshots SHALL carry their model's averages; idle snapshots SHALL carry the current model's averages and, when the branch holds runs, the session totals and the last run's outcome. `null` SHALL be emitted only when the session shuts down. Hiding the built-in readout with `/tps` SHALL NOT change the broadcasts. A `pi-tps:request` event SHALL cause the current snapshot to be re-emitted. Payloads are read-only for subscribers.

#### Scenario: Late subscriber
- **WHEN** another extension subscribes after a run settled and emits `pi-tps:request`
- **THEN** it receives the current snapshot immediately

#### Scenario: Idle after a run
- **WHEN** the first run of a session settles
- **THEN** the snapshot has phase `idle`, totals of one run and the averages of the model that served it

## REMOVED Requirements

### Requirement: Run TPS
**Reason**: The readout no longer shows a run's own TPS; per-model smoothed averages replace it.
**Migration**: Consumers that need a run figure compute it from the request records of the `pi-tps:run` payload, whose `tps`, `generatedTokens` and `generationMs` fields are unchanged.

### Requirement: Run TTFT, sums and elapsed time
**Reason**: Run figures are no longer shown; session totals and per-model averages replace them.
**Migration**: See "Session totals" and "Per-model averages"; per-run values remain in the `pi-tps:run` payload.

### Requirement: Session aggregates
**Reason**: The session TPS and mean TTFT over all models are replaced by smoothed averages per model; the summed figures move to "Session totals".
**Migration**: See "Per-model averages", "Averages are smoothed" and "Session totals".
