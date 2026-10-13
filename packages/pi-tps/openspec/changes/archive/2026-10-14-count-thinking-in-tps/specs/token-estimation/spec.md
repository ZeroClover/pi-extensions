# Spec Delta

## MODIFIED Requirements

### Requirement: Calibration ratio per provider and model
After each settled, non-burst request with a finite positive `usage.output` and a raw estimate above 50 tokens, the system SHALL update the output calibration ratio of the model that produced the response, stored under `<provider>/<response model>` and, when the requested model differs, also under `<provider>/<requested model>`. The sample SHALL be clamped to [0.25, 4] and folded into an exponential moving average with weight 0.3; the first sample SHALL set the ratio directly. A reasoning breakdown exists only when `usage.reasoning` is positive; with one, the sample compares the visible output with the output estimate, without one it compares `usage.output` with the estimate of everything streamed.

#### Scenario: Reasoning breakdown
- **WHEN** usage reports output 900 and reasoning 600 and the raw estimate of the streamed text output is 250
- **THEN** the sample is (900 − 600) / 250 = 1.2

#### Scenario: Reasoning reported as zero with streamed thinking
- **WHEN** usage reports output 900 and reasoning 0, 500 thinking tokens and 250 output tokens were estimated from the stream
- **THEN** the sample is 900 / 750 = 1.2, not 900 / 250

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
Live token counts and live TPS SHALL multiply the raw output estimate by the output ratio and the raw thinking estimate by the thinking ratio of the active model; when a ratio is missing the factor SHALL be 1 and the readout SHALL mark every live figure that uses that estimate (TPS while the window holds such tokens, and the count itself) as uncalibrated.

#### Scenario: Uncalibrated model
- **WHEN** the active model has no calibration entry
- **THEN** live figures use the raw estimate and show the uncalibrated marker, also while TPS is not yet available

#### Scenario: Calibrated model
- **WHEN** the active model has output ratio 1.2 and the raw window estimate is 100 output tokens
- **THEN** the live figure uses 120 tokens

#### Scenario: Output calibrated, thinking not
- **WHEN** the active model has an output ratio but no thinking ratio and a thinking phase is streaming
- **THEN** the live TPS and the thinking count carry the marker and the output count does not; once only output deltas lie in the window the TPS loses the marker

### Requirement: Calibration persists across sessions
Calibration ratios SHALL be stored in the directory `<agent-dir>/pi-tps-calibration/` as numbered versions of file format version 2 and loaded at session start. A missing directory, or a newest version in another file format, SHALL be treated as empty; a corrupt newest version SHALL produce one warning and the newest valid version SHALL be used; a failing write SHALL produce one warning per session and SHALL not interrupt measurement.

#### Scenario: Restart
- **WHEN** Pi restarts after calibrating a model
- **THEN** the first live readout for that model uses the stored ratios

#### Scenario: Corrupt file
- **WHEN** the newest calibration version contains invalid JSON
- **THEN** the newest valid version is used and the user sees one warning

#### Scenario: Older file format
- **WHEN** the newest calibration version has file format version 1
- **THEN** it is ignored without a warning and the next publish writes format version 2

## ADDED Requirements

### Requirement: Thinking calibration ratio per provider and model
After each settled, non-burst request whose thinking was streamed, with a positive `usage.reasoning` and a raw thinking estimate above 50 tokens, the system SHALL update the model's thinking ratio under the same keys as the output ratio: the sample `usage.reasoning / raw thinking estimate` clamped to [0.25, 100] and folded into the same moving average. Hidden thinking and requests without a positive `usage.reasoning` SHALL NOT update it.

#### Scenario: Full chain of thought
- **WHEN** usage reports reasoning 1000 and the raw thinking estimate is 950
- **THEN** the thinking ratio sample is 1000 / 950 ≈ 1.05

#### Scenario: Summary
- **WHEN** usage reports reasoning 6000 and the raw thinking estimate of the summary is 120
- **THEN** the thinking ratio sample is 50

#### Scenario: Summary far shorter than the clamp allows
- **WHEN** usage reports reasoning 20 000 and the raw thinking estimate is 100
- **THEN** the sample is clamped to 100

#### Scenario: No reasoning count
- **WHEN** usage reports reasoning 0 after 500 estimated thinking tokens
- **THEN** the thinking ratio is not updated and the output ratio sample uses the total

#### Scenario: Independent of the output ratio
- **WHEN** a model has output ratio 1.1 and no thinking ratio yet, and a request yields thinking sample 8
- **THEN** the thinking ratio becomes 8 and the output ratio is unchanged by that sample
