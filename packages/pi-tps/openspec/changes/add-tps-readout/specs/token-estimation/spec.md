# Spec Delta

## Purpose

Estimates token counts for streamed text while the provider has not yet reported usage, and calibrates the estimate per provider and model from the usage the provider reports at the end of each request.

## ADDED Requirements

### Requirement: Incremental estimation per delta
Each content delta SHALL be estimated once when it arrives; estimates SHALL be accumulated incrementally so that computing a window total does not re-estimate earlier deltas.

#### Scenario: Long stream
- **WHEN** 5 000 deltas have arrived
- **THEN** computing the live window total touches only the deltas inside the window, not the full text

### Requirement: Estimates are multilingual
The estimator SHALL produce a token count for text containing CJK characters that is closer to provider counts than a fixed characters-per-token ratio.

#### Scenario: Chinese output
- **WHEN** a response consists of Chinese prose
- **THEN** the raw estimate is within 30 % of the provider's reported output tokens before calibration

### Requirement: Calibration ratio per provider and model
After each non-burst, non-aborted request with a finite positive `usage.output`, the system SHALL update a calibration ratio `reported / estimated` for the key `<provider>/<model>`, where `model` is the response model when the provider reports one. The ratio SHALL be an exponential moving average over at least the last several requests, clamped to [0.25, 4].

#### Scenario: First request for a model
- **WHEN** a model with no calibration reports 1000 output tokens for an estimate of 800
- **THEN** the ratio for that model becomes 1.25

#### Scenario: Subsequent requests
- **WHEN** a model with ratio 1.25 reports 1000 for an estimate of 1000
- **THEN** the ratio moves toward 1.0 without jumping to it

#### Scenario: Outlier
- **WHEN** a request would produce a ratio of 9
- **THEN** the stored ratio is clamped to 4

### Requirement: Calibrated live counts
Live token counts and live TPS SHALL multiply the raw estimate by the calibration ratio of the active model; when no ratio exists the factor SHALL be 1 and the readout SHALL mark the value as uncalibrated.

#### Scenario: Uncalibrated model
- **WHEN** the active model has no calibration entry
- **THEN** live figures use the raw estimate and show the uncalibrated marker

#### Scenario: Calibrated model
- **WHEN** the active model has ratio 1.2 and the raw window estimate is 100 tokens
- **THEN** the live figure uses 120 tokens

### Requirement: Calibration persists across sessions
Calibration ratios SHALL be stored in `<agent-dir>/pi-tps-calibration.json`, loaded at session start and written after each update. A missing or unreadable file SHALL be treated as empty; an unwritable file SHALL produce one warning per session and not interrupt measurement.

#### Scenario: Restart
- **WHEN** Pi restarts after calibrating a model
- **THEN** the first live readout for that model uses the stored ratio

#### Scenario: Corrupt file
- **WHEN** the calibration file contains invalid JSON
- **THEN** calibration starts empty and the user sees one warning

### Requirement: Model switch
When the active model changes, subsequent live figures SHALL use the calibration ratio of the new model.

#### Scenario: Switch to a calibrated model
- **WHEN** the user switches from an uncalibrated model to a model with ratio 0.9
- **THEN** the next request's live figures use 0.9 and no uncalibrated marker
