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
The sum of the per-delta estimates of a stream SHALL stay within 2 % (at least 2 tokens) of the estimate of the whole text, whatever the delta sizes, including long runs without separators such as digits, identifiers, punctuation and CJK text.

#### Scenario: Long digit run
- **WHEN** 1000 digits stream as deltas of 1, 2, 4 or 128 characters
- **THEN** each total is within 2 % of the whole-text estimate

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
Live token counts and live TPS SHALL multiply the raw estimate by the calibration ratio of the active model; when no ratio exists the factor SHALL be 1 and the readout SHALL mark the value as uncalibrated.

#### Scenario: Uncalibrated model
- **WHEN** the active model has no calibration entry
- **THEN** live figures use the raw estimate and show the uncalibrated marker

#### Scenario: Calibrated model
- **WHEN** the active model has ratio 1.2 and the raw window estimate is 100 tokens
- **THEN** the live figure uses 120 tokens

### Requirement: Calibration persists across sessions
Calibration ratios SHALL be stored in `<agent-dir>/pi-tps-calibration.json`, loaded at session start and written after each update. Concurrent Pi sessions SHALL NOT lose each other's updates. A missing or unreadable file SHALL be treated as empty; an unwritable file SHALL produce one warning per session, SHALL not interrupt measurement, and the ratios updated in memory SHALL stay authoritative for the rest of the session.

#### Scenario: Restart
- **WHEN** Pi restarts after calibrating a model
- **THEN** the first live readout for that model uses the stored ratio

#### Scenario: Corrupt file
- **WHEN** the calibration file contains invalid JSON
- **THEN** calibration starts empty and the user sees one warning

#### Scenario: Concurrent sessions
- **WHEN** two Pi sessions update different models at the same moment
- **THEN** the file afterwards holds both updates

#### Scenario: Unwritable file
- **WHEN** the file is readable but every write fails and three samples of 2 arrive for a model with ratio 1
- **THEN** the in-memory ratio keeps converging toward 2

### Requirement: Model identity
Live figures SHALL use the calibration ratio of the model that serves the request: the selected model when the request starts, replaced by the model named in the assistant `message_start` (the physical model behind a virtual model) as soon as it is known. When the active model changes, subsequent live figures SHALL use the ratio of the new model.

#### Scenario: Virtual model
- **WHEN** the selected virtual model routes a request to `anthropic/claude-sonnet-4`, which has ratio 1.3
- **THEN** live figures use 1.3 from the stream's start and the calibration update is stored for `anthropic/claude-sonnet-4`

#### Scenario: Switch to a calibrated model
- **WHEN** the user switches from an uncalibrated model to a model with ratio 0.9
- **THEN** the next request's live figures use 0.9 and no uncalibrated marker
