# Spec Delta

## ADDED Requirements

### Requirement: Calibration can be disabled
When the configuration sets `calibration` to false, live figures SHALL use the raw estimates, no calibration sample SHALL be taken, and the calibration directory SHALL be neither read nor written. A request without reported usage SHALL then record its raw estimate.

#### Scenario: Calibration off
- **WHEN** `calibration` is false and ten requests settle with reported usage
- **THEN** the live figures of every request use a factor of 1 and the calibration directory is unchanged

#### Scenario: Corrupt calibration while disabled
- **WHEN** `calibration` is false and the newest calibration version is invalid JSON
- **THEN** no calibration warning is shown

## MODIFIED Requirements

### Requirement: Calibration ratio per provider and model
While calibration is enabled, after each settled, non-burst request with a finite positive `usage.output` and a raw estimate above 50 tokens, the system SHALL update the output calibration ratio of the model that produced the response, stored under `<provider>/<response model>` and, when the requested model differs, also under `<provider>/<requested model>`. The sample SHALL be clamped to [0.25, 4] and folded into an exponential moving average with weight 0.3; the first sample SHALL set the ratio directly. A reasoning breakdown exists only when `usage.reasoning` is positive; with one, the sample compares the visible output with the output estimate, without one it compares `usage.output` with the estimate of everything streamed.

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

### Requirement: Thinking calibration ratio per provider and model
While calibration is enabled, after each settled, non-burst request whose thinking was streamed, with a positive `usage.reasoning` and a raw thinking estimate above 50 tokens, the system SHALL update the model's thinking ratio under the same keys as the output ratio: the sample `usage.reasoning / raw thinking estimate` clamped to [0.25, 100] and folded into the same moving average. Hidden thinking and requests without a positive `usage.reasoning` SHALL NOT update it.

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

### Requirement: Calibration persists across sessions
While calibration is enabled, calibration ratios SHALL be stored in the directory `<agent-dir>/pi-tps-calibration/` as numbered versions of file format version 2 and loaded at session start. A missing directory, or a newest version in another file format, SHALL be treated as empty; a corrupt newest version SHALL produce one warning and the newest valid version SHALL be used; a failing write SHALL produce one warning per session and SHALL not interrupt measurement.

#### Scenario: Restart
- **WHEN** Pi restarts after calibrating a model
- **THEN** the first live readout for that model uses the stored ratios

#### Scenario: Corrupt file
- **WHEN** the newest calibration version contains invalid JSON
- **THEN** the newest valid version is used and the user sees one warning

#### Scenario: Older file format
- **WHEN** the newest calibration version has file format version 1
- **THEN** it is ignored without a warning and the next publish writes format version 2

### Requirement: Calibrated live counts
Live token counts and live TPS SHALL multiply the raw output estimate by the output ratio and the raw thinking estimate by the thinking ratio of the active model; when a ratio is missing, or calibration is disabled, the factor SHALL be 1. The readout SHALL NOT mark live figures as uncalibrated.

#### Scenario: Uncalibrated model
- **WHEN** the active model has no calibration entry
- **THEN** live figures use the raw estimate and carry no marker

#### Scenario: Calibrated model
- **WHEN** the active model has output ratio 1.2 and the raw window estimate is 100 output tokens
- **THEN** the live figure uses 120 tokens

#### Scenario: Output calibrated, thinking not
- **WHEN** the active model has an output ratio but no thinking ratio and a thinking phase is streaming
- **THEN** the thinking count and the thinking share of the live TPS use a factor of 1 and the output count uses the output ratio

### Requirement: Model identity
Live figures SHALL use the calibration ratio of the model that serves the request: the selected model when the request starts, replaced by the model named in the assistant `message_start` (the physical model behind a virtual model) as soon as it is known. When the active model changes, subsequent live figures SHALL use the ratio of the new model.

#### Scenario: Virtual model
- **WHEN** the selected virtual model routes a request to `anthropic/claude-sonnet-4`, which has ratio 1.3
- **THEN** live figures use 1.3 from the stream's start and the calibration update is stored for `anthropic/claude-sonnet-4`

#### Scenario: Switch to a calibrated model
- **WHEN** the user switches from an uncalibrated model to a model with ratio 0.9
- **THEN** the next request's live figures use 0.9
