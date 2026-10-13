# telemetry-history Specification

## Purpose

Keeps per-run telemetry in the session so the readout and the session averages survive resume, reload and branch navigation, defines how run and session figures are aggregated from request records, and exposes the data to other extensions over Pi's event bus.

## Requirements

### Requirement: Telemetry is persisted per run
When a run settles, the system SHALL append one session entry with `customType: "pi-tps"` containing the run record: wall-clock start, elapsed time, aborted flag and the records of its measured requests (settled, burst and aborted ones). Errored and deferred requests SHALL NOT appear in it. A run without any measured request SHALL NOT produce an entry. The entry SHALL NOT enter model context.

#### Scenario: Settled run
- **WHEN** a run with three measured requests settles
- **THEN** one `pi-tps` custom entry holding the run record with three request records is appended to the session

#### Scenario: Run that only errored
- **WHEN** the only request of a run ends in a provider error and the run settles without a retry
- **THEN** no entry is appended

### Requirement: Persistence can be disabled
When the configuration sets `persist` to false, no `pi-tps` entries SHALL be appended; the runs SHALL then live in memory only, start empty on every session start and not follow `/tree` navigation.

#### Scenario: Persistence off
- **WHEN** `persist` is false and three runs settle, then the user runs `/reload`
- **THEN** the session file holds no `pi-tps` entries and the idle readout shows `TPS — · TTFT —` after the reload

### Requirement: Record format is independent of other extensions
The `pi-tps` record format SHALL be owned by this package; entries written by other TPS extensions (for example `customType: "tps"`) SHALL be ignored during reconstruction.

#### Scenario: Foreign entries on the branch
- **WHEN** the branch holds entries with `customType: "tps"` from another extension
- **THEN** reconstruction skips them and aggregates reflect only `pi-tps` entries

### Requirement: Record schema is versioned
Each run record SHALL carry a `version` field. Entries with an unknown version SHALL be ignored during reconstruction.

#### Scenario: Future record
- **WHEN** a session contains a `pi-tps` entry with a higher version
- **THEN** reconstruction skips it without error

### Requirement: Reconstruction on session start and branch change
On `session_start` and `session_tree` the system SHALL rebuild the last run and the session aggregates from the `pi-tps` entries on the current branch only.

#### Scenario: Resume
- **WHEN** a session with five settled runs is resumed
- **THEN** the idle readout shows the fifth run in `last` mode and the five-run session average in `session` mode

#### Scenario: Branch switch
- **WHEN** the user navigates with `/tree` to a branch holding two runs
- **THEN** the session aggregates reflect those two runs only

### Requirement: Run TPS
The run TPS SHALL be the sum of visible output tokens divided by the sum of active output spans over the run's settled, non-burst requests whose own active output span is at least 1 s, marked estimated when a contributing request relied on the estimate; when no settled request qualifies, aborted ones that qualify SHALL be used. When every request was a burst, the run SHALL report the burst throughput (summed output tokens over summed elapsed times) instead; otherwise it has no TPS.

#### Scenario: Aggregate generation rate
- **WHEN** a run holds requests with 1000 visible output tokens over 10 s, 300 over 2 s, and a tool call with 80 over 0.2 s
- **THEN** the run TPS is 1300 / 12 ≈ 108.3 and the tool call does not contribute

#### Scenario: Span just under one second
- **WHEN** a request's active output span is 999.6 ms and the record is persisted and read back
- **THEN** the request still does not contribute to the run or session TPS

#### Scenario: Burst tool call and short reply
- **WHEN** a run holds a burst tool-call request and a reply too short to measure
- **THEN** the run has no TPS and no burst throughput

#### Scenario: Aborted-only run
- **WHEN** the only request of a run was aborted after streaming 230 visible tokens over 2 s of active output
- **THEN** the run TPS is 115 and the run TTFT is that request's TTFT

#### Scenario: Only burst requests
- **WHEN** both requests of a run were burst deliveries of 900 tokens in 4 s and 300 tokens in 2 s
- **THEN** the run has no TPS and reports a burst throughput of 200 tokens per second

### Requirement: Run TTFT, sums and elapsed time
The run TTFT SHALL be the mean over its non-aborted requests that have one, or over its aborted requests when no other request has one. Input, cache read, cache write and output tokens, thinking tokens, active thinking spans, stall time and stall count SHALL be summed over all request records; cost SHALL be summed over records that carry one and be absent when none does. The run's elapsed time SHALL be its wall time from `agent_start` to `agent_settled` on the monotonic clock.

#### Scenario: Burst and aborted requests
- **WHEN** a run holds two normal requests, one burst request and one aborted request
- **THEN** the run TPS uses the two normal requests, the mean TTFT excludes the aborted request, and the tokens and cost include all four

### Requirement: Session aggregates
Session aggregates SHALL apply the run formulas to all request records of all runs on the current branch, and SHALL also count the runs.

#### Scenario: Mixed runs
- **WHEN** the branch holds a run whose requests total 600 visible output tokens over 10 s of active output span and a run with 900 tokens over 10 s
- **THEN** the session TPS is 75 and the run count is 2

### Requirement: Status snapshots are broadcast
Every readout state change, and every ticker refresh while a run is active, SHALL be emitted on the event bus channel `pi-tps:status` with a snapshot describing phase, figures and flags; `null` SHALL be emitted only when the session shuts down. Hiding the built-in readout with `/tps` SHALL NOT change the broadcasts. A `pi-tps:request` event SHALL cause the current snapshot to be re-emitted. Payloads are read-only for subscribers.

#### Scenario: Late subscriber
- **WHEN** another extension subscribes after a run settled and emits `pi-tps:request`
- **THEN** it receives the current snapshot immediately

### Requirement: Telemetry records are broadcast
Each request record SHALL be emitted on `pi-tps:telemetry` when its request settles or aborts, and each run record SHALL be emitted on `pi-tps:run` when the run settles, whether or not persistence is enabled. The `pi-tps:run` payload SHALL equal the persisted entry data.

#### Scenario: Dashboard extension
- **WHEN** a run settles with persistence enabled
- **THEN** the `pi-tps:run` payload equals the persisted record
