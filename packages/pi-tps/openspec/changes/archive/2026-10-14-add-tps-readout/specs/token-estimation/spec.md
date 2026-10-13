# Spec Delta

## Purpose

Estimates token counts for streamed text while the provider has not yet reported usage, and calibrates the estimate per provider and model from the usage the provider reports at the end of each request.

## ADDED Requirements

### Requirement: Incremental estimation per delta
Each content delta SHALL be estimated once when it arrives; estimates SHALL be accumulated incrementally so that computing a window total does not re-estimate earlier deltas.

#### Scenario: Long stream
- **WHEN** 5 000 deltas have arrived
- **THEN** computing the live window total touches only the deltas inside the window, not the full text

### Requirement: Estimates do not depend on delta size
After every delta, the running total of a stream SHALL equal the estimate of the text received so far whenever no single segment (a run of word characters, or of whitespace and punctuation) exceeds 512 characters; longer segments SHALL be estimated in 256-character pieces. Increments MAY be negative; a negative increment corrects the total and SHALL NOT count as arriving tokens.

#### Scenario: Suffix changes a segment's class
- **WHEN** `12345678901234567890n` streams one character per delta
- **THEN** the total equals the whole-text estimate of 3, the last delta contributing a negative correction

#### Scenario: Any delta size
- **WHEN** English prose, JSON tool arguments, identifiers and Chinese prose with ASCII punctuation stream in deltas of 1 to 1000 characters
- **THEN** every total equals the whole-text estimate

#### Scenario: Over-long segment
- **WHEN** a run of 1800 newlines streams
- **THEN** it is estimated as pieces of at most 256 characters, not as one segment

### Requirement: Estimates are multilingual
The estimator SHALL produce a token count for text containing CJK characters that is closer to provider counts than a fixed characters-per-token ratio. Accuracy is verified against the fixture texts in the package tests and their `o200k_base` and `cl100k_base` counts, not guaranteed for every tokenizer.

#### Scenario: Chinese output
- **WHEN** the Chinese prose fixture is estimated, whole or streamed in deltas
- **THEN** the raw estimate is within 30 % of both reference counts

### Requirement: Calibration ratio per provider and model
After each settled, non-burst request with a finite positive `usage.output` and a raw estimate above 50 tokens, the system SHALL update the calibration ratio of the model that produced the response, stored under `<provider>/<response model>` and, when the requested model differs, also under `<provider>/<requested model>`. The sample SHALL be clamped to [0.25, 4] and folded into an exponential moving average with weight 0.3; the first sample SHALL set the ratio directly.

#### Scenario: Reasoning breakdown
- **WHEN** usage reports output 900 and reasoning 600 and the raw estimate of the streamed text output is 250
- **THEN** the sample is (900 − 600) / 250 = 1.2; without a reasoning breakdown the sample is usage.output over the raw estimate of everything streamed

#### Scenario: First request for a model
- **WHEN** a model with no calibration reports 1000 output tokens for an estimate of 800
- **THEN** the ratio for that model becomes 1.25

#### Scenario: Subsequent requests
- **WHEN** a model with ratio 1.25 reports 1000 for an estimate of 1000
- **THEN** the ratio moves toward 1.0 without jumping to it

#### Scenario: Outlier as first sample
- **WHEN** a model with no calibration produces a sample of 9
- **THEN** the stored ratio is 4

#### Scenario: Outlier after calibration
- **WHEN** a model with ratio 1 produces a sample of 9
- **THEN** the sample is clamped to 4 and the ratio becomes 1.9

#### Scenario: Tiny response
- **WHEN** a request's raw estimate is 40 tokens
- **THEN** the ratio is not updated

### Requirement: Calibrated live counts
Live token counts and live TPS SHALL multiply the raw estimate by the calibration ratio of the active model; when no ratio exists the factor SHALL be 1 and the readout SHALL mark every live figure that uses the estimate (TPS, output and thinking tokens) as uncalibrated.

#### Scenario: Uncalibrated model
- **WHEN** the active model has no calibration entry
- **THEN** live figures use the raw estimate and show the uncalibrated marker, also while TPS is not yet available

#### Scenario: Calibrated model
- **WHEN** the active model has ratio 1.2 and the raw window estimate is 100 tokens
- **THEN** the live figure uses 120 tokens

### Requirement: Calibration persists across sessions
Calibration ratios SHALL be stored in the directory `<agent-dir>/pi-tps-calibration/` as numbered versions and loaded at session start. A missing directory SHALL be treated as empty; a corrupt newest version SHALL produce one warning and the newest valid version SHALL be used; a failing write SHALL produce one warning per session and SHALL not interrupt measurement.

#### Scenario: Restart
- **WHEN** Pi restarts after calibrating a model
- **THEN** the first live readout for that model uses the stored ratio

#### Scenario: Corrupt file
- **WHEN** the newest calibration version contains invalid JSON
- **THEN** the newest valid version is used and the user sees one warning

### Requirement: Calibration is shared by concurrent sessions
Each session SHALL number its samples in order, and each version SHALL record per session the highest number applied to it. An update SHALL publish the next version, derived from the newest one, with an exclusive and atomic creation; a sample SHALL count as stored exactly when the newest version records its number for its session. Samples not yet stored SHALL be applied once on top of the newest version for the session's own ratios and retried with the next update and at session shutdown.

#### Scenario: Concurrent sessions
- **WHEN** two Pi sessions update different models at the same moment
- **THEN** the newest version afterwards holds both updates

#### Scenario: Concurrent update of one model
- **WHEN** a session's sample for a model is not yet published while another session publishes a sample for the same model
- **THEN** the newest version afterwards reflects both samples and the other session's sample is not reverted

#### Scenario: Writer paused across several publishes
- **WHEN** a session reads version 1, pauses while another session publishes versions 2 to 5 and removes old ones, then creates version 2 again
- **THEN** the session sees that the newest version lacks its sample, publishes it on top of version 5, and a new session restores it

#### Scenario: Large backlog
- **WHEN** 513 samples queue up while writing fails and writing then succeeds
- **THEN** a new session restores exactly 513 samples and the ratio and time of the last one

#### Scenario: Pause after publishing
- **WHEN** a session publishes its sample and pauses while other sessions publish 512 samples, then checks the newest version
- **THEN** it finds its sample stored and does not apply it again

#### Scenario: No later update
- **WHEN** the last sample of a session could not be published when it arrived
- **THEN** it is published at session shutdown

#### Scenario: Unwritable file
- **WHEN** the directory is readable but every write fails and three samples of 2 arrive for a model with ratio 1
- **THEN** the in-memory ratio keeps converging toward 2

### Requirement: Session records are reclaimed safely
A session SHALL remove its own record from the newest version when it shuts down. Records of sessions not seen for 7 days SHALL be removed by the next publish. A session that finds its own record removed although it published before SHALL drop the samples whose storage it can no longer prove instead of applying them again. A version counts as possibly published as soon as its creation succeeds, and also when the creation fails with an error, whatever fails afterwards.

#### Scenario: Crashed session
- **WHEN** a session's record was last updated 8 days ago and another session publishes
- **THEN** the new version no longer holds that record

#### Scenario: Cleanup fails after publishing
- **WHEN** a session's version is created but removing old versions then fails, and the session retries only after its record was removed
- **THEN** it treats the samples of that version as possibly stored and drops them instead of applying them again

#### Scenario: Session paused beyond the retention
- **WHEN** a session published samples, paused for more than 7 days so that its record was removed, and resumes
- **THEN** it drops those samples and the stored ratio is not changed by them a second time

### Requirement: Model identity
Live figures SHALL use the calibration ratio of the model that serves the request: the selected model when the request starts, replaced by the model named in the assistant `message_start` (the physical model behind a virtual model) as soon as it is known. When the active model changes, subsequent live figures SHALL use the ratio of the new model.

#### Scenario: Virtual model
- **WHEN** the selected virtual model routes a request to `anthropic/claude-sonnet-4`, which has ratio 1.3
- **THEN** live figures use 1.3 from the stream's start and the calibration update is stored for `anthropic/claude-sonnet-4`

#### Scenario: Switch to a calibrated model
- **WHEN** the user switches from an uncalibrated model to a model with ratio 0.9
- **THEN** the next request's live figures use 0.9 and no uncalibrated marker
