# Spec Delta

## Purpose

Defines the user configuration file for pi-retry: where it lives, what it contains, its defaults, and how invalid input is handled.

## ADDED Requirements

### Requirement: Configuration file location
Configuration SHALL be read from `<agent-dir>/pi-retry.json` (the directory returned by Pi's `getAgentDir()`) at session start. A missing file SHALL yield the defaults silently. Changes take effect after `/reload` or a new session.

#### Scenario: No file
- **WHEN** the file does not exist
- **THEN** defaults apply and no warning is shown

### Requirement: Configuration schema
The file SHALL be a JSON object with optional keys: `enabled` (boolean, default true), `maxRetries` (integer 0–1000, default 10), `baseDelayMs` (integer 100–3 600 000, default 2000), `maxBackoffMs` (integer ≥ `baseDelayMs` and ≤ 86 400 000, default 60 000), `maxRetryAfterMs` (integer 0–86 400 000, default 1 800 000; 0 disables the limit), and `patterns` (object with optional `retryable` and `nonRetryable` arrays of regular-expression strings, case-insensitive, default empty).

#### Scenario: Partial file
- **WHEN** the file contains only `{ "maxRetries": 20 }`
- **THEN** every other setting keeps its default

#### Scenario: Full file
- **WHEN** the file contains `{ "maxRetries": 5, "baseDelayMs": 1000, "maxBackoffMs": 30000, "maxRetryAfterMs": 600000, "patterns": { "retryable": ["backend saturated"], "nonRetryable": ["tenant suspended"] } }`
- **THEN** all six values are applied

### Requirement: Validation and fallback
Invalid JSON, a non-object top level, an unknown key, or an invalid field SHALL produce one warning per problem via the UI notification at session start and SHALL fall back to the default for that field only; the extension SHALL never be disabled by a bad configuration unless `enabled` is explicitly `false`.

#### Scenario: Invalid JSON
- **WHEN** the file is not valid JSON
- **THEN** all defaults apply and one warning names the file and the parse error

#### Scenario: Out-of-range value
- **WHEN** `maxRetries` is `-1`
- **THEN** the default 10 applies and one warning names `maxRetries`

#### Scenario: Cap below base
- **WHEN** `baseDelayMs` is 5000 and `maxBackoffMs` is 1000
- **THEN** `maxBackoffMs` is raised to 5000 and one warning names `maxBackoffMs`

#### Scenario: Invalid pattern
- **WHEN** `patterns.retryable` contains `"("`
- **THEN** that entry is ignored with one warning naming it and the other entries are kept

#### Scenario: Unknown key
- **WHEN** the file contains `"jitter": 0.5`
- **THEN** one warning says `jitter` is unknown and is ignored
