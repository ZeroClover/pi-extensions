# Spec Delta

## Purpose

Keeps per-request telemetry in the session so the readout and the session averages survive resume, reload and branch navigation, and exposes the data to other extensions over Pi's event bus.

## ADDED Requirements

### Requirement: Telemetry is persisted per request
After each request settles, aborts, or is marked burst, the system SHALL append a session entry with `customType: "pi-tps"` containing the telemetry record (model, timing, tokens, cost, flags, timestamp). The entry SHALL NOT enter model context. Errored and deferred requests SHALL NOT produce an entry.

#### Scenario: Settled request
- **WHEN** a request settles
- **THEN** a `pi-tps` custom entry with the full record is appended to the session

#### Scenario: Provider error
- **WHEN** the request ends in error
- **THEN** no entry is appended

### Requirement: Persistence can be disabled
When the configuration sets `persist` to false, no `pi-tps` entries SHALL be appended; the last record and session aggregates SHALL then live in memory only and start empty on every session start.

#### Scenario: Persistence off
- **WHEN** `persist` is false and three requests settle, then the user runs `/reload`
- **THEN** the session file holds no `pi-tps` entries and the idle readout shows placeholders after the reload

### Requirement: Record format is independent of other extensions
The `pi-tps` record format SHALL be owned by this package; entries written by other TPS extensions (for example `customType: "tps"`) SHALL be ignored during reconstruction.

#### Scenario: Foreign entries on the branch
- **WHEN** the branch holds entries with `customType: "tps"` from another extension
- **THEN** reconstruction skips them and aggregates reflect only `pi-tps` entries

### Requirement: Record schema is versioned
Each record SHALL carry a `version` field. Entries with an unknown version SHALL be ignored during reconstruction.

#### Scenario: Future record
- **WHEN** a session contains a `pi-tps` entry with a higher version
- **THEN** reconstruction skips it without error

### Requirement: Reconstruction on session start and branch change
On `session_start` and `session_tree` the system SHALL rebuild the last settled record and the session aggregates from the `pi-tps` entries on the current branch only.

#### Scenario: Resume
- **WHEN** a session with five settled requests is resumed
- **THEN** the idle readout shows the fifth request in `last` mode and the five-request average in `session` mode

#### Scenario: Branch switch
- **WHEN** the user navigates with `/tree` to a branch holding two records
- **THEN** aggregates reflect those two records only

### Requirement: Session aggregates
Session aggregates SHALL comprise: request count, mean TTFT, mean output TPS over non-burst non-aborted requests, mean thinking TPS over requests with thinking, summed input/output/cache tokens, and summed cost over records that carry cost.

#### Scenario: Mixed records
- **WHEN** the branch holds two normal requests (TPS 50 and 70) and one burst request
- **THEN** mean TPS is 60 and the request count is 3

### Requirement: Status snapshots are broadcast
Every readout state change SHALL be emitted on the event bus channel `pi-tps:status` with a snapshot describing phase, figures and flags; `null` SHALL be emitted when the display must be cleared. A `pi-tps:request` event SHALL cause the current snapshot to be re-emitted.

#### Scenario: Late subscriber
- **WHEN** another extension subscribes after a request settled and emits `pi-tps:request`
- **THEN** it receives the current snapshot immediately

### Requirement: Telemetry records are broadcast
Each persisted record SHALL also be emitted on `pi-tps:telemetry` so other extensions can react without reading the session file.

#### Scenario: Dashboard extension
- **WHEN** a request settles
- **THEN** the `pi-tps:telemetry` payload equals the persisted record
