# Spec Delta

## Purpose

Defines the user configuration file for pi-tps: where it lives, what it contains, how colour thresholds are resolved for a provider and model, and how invalid input is handled.

## ADDED Requirements

### Requirement: Configuration file location
Configuration SHALL be read from `<agent-dir>/pi-tps.json` (the directory returned by Pi's `getAgentDir()`) at session start. A missing file SHALL yield the defaults silently. Changes take effect after `/reload`.

#### Scenario: No file
- **WHEN** the file does not exist
- **THEN** defaults apply and no warning is shown

### Requirement: Configuration schema
The file SHALL be a JSON object with optional keys: `enabled` (boolean), `persist` (boolean, default true), `labels` (`"text"` | `"symbols"`, default `"text"`), `summaryMode` (`"last"` | `"session"`), `baseColor` (colour), `animation` ({ `enabled`: boolean, `intervalMs`: number from 50 to 1000, `frames`: non-empty strings without control characters }), `thresholds` (threshold list), and `overrides` (object mapping match keys to threshold lists).

#### Scenario: Partial file
- **WHEN** the file contains only `{ "summaryMode": "session" }`
- **THEN** every other setting keeps its default

#### Scenario: Symbol labels
- **WHEN** the file contains `{ "labels": "symbols" }`
- **THEN** the readout uses the symbol style after the next session start or `/reload`

#### Scenario: Unknown label style
- **WHEN** `labels` is `"emoji"`
- **THEN** the text style applies and one warning names `labels`

### Requirement: Threshold list
A threshold list SHALL be an array of `{ "min": number, "color": colour }` entries. Entries SHALL be sorted by `min` for resolution, entries with equal `min` keeping their file order so that the later one wins; an empty list leaves the TPS in the base colour; the default list SHALL be `[{min:0,color:"error"},{min:30,color:"warning"},{min:80,color:"success"}]`.

#### Scenario: Unsorted input
- **WHEN** the list is given as 80, 0, 30
- **THEN** resolution behaves as if it were sorted ascending

### Requirement: Colour values
A colour SHALL be either a Pi theme colour token name (for example `success`, `warning`, `error`, `accent`, `dim`, `muted`, `text`) or a hex colour `#rgb` / `#rrggbb`. Theme tokens SHALL follow the active theme; hex colours SHALL be rendered through the terminal colour mode Pi detected.

#### Scenario: Hex colour
- **WHEN** a threshold uses `"#ff8800"`
- **THEN** the TPS figure renders in that colour in a truecolor terminal and the nearest palette colour otherwise

#### Scenario: Unknown token
- **WHEN** a colour is `"purple"`
- **THEN** the entry is rejected with a warning naming the key and the default colour is used for that entry

### Requirement: Override match keys
Override keys SHALL be of the form `provider/model`, `model` (no slash) or `provider/*`. The `model` part MAY contain `*` wildcards matching any run of characters; the provider part SHALL be exact or `*`. Matching SHALL be case-insensitive.

#### Scenario: Glob on model
- **WHEN** an override key is `anthropic/claude-*` and the active model is `anthropic/claude-sonnet-4`
- **THEN** the override matches

#### Scenario: Model-only key
- **WHEN** an override key is `gpt-5*` and the active model is `openrouter/gpt-5-mini`
- **THEN** the override matches

### Requirement: Override precedence
When several override keys match, precedence SHALL be: exact `provider/model`, then `provider/<glob>`, then model-only (exact before glob), then `provider/*`, then the global `thresholds`. Within one level a more specific pattern (fewer wildcard-matched characters) SHALL win, and among equally specific patterns the first in the file.

#### Scenario: Exact beats glob
- **WHEN** both `anthropic/claude-sonnet-4` and `anthropic/claude-*` are configured
- **THEN** the exact entry is used for `anthropic/claude-sonnet-4`

#### Scenario: Provider-scoped glob beats model-only
- **WHEN** both `anthropic/claude-*` and `claude-*` are configured
- **THEN** `anthropic/claude-*` is used for `anthropic/claude-opus-4`

### Requirement: Validation and fallback
Invalid JSON, a non-object top level, or an invalid field SHALL produce one warning per problem via the UI notification at session start and SHALL fall back to the default for that field only; the readout SHALL never be disabled by a bad configuration.

#### Scenario: Invalid JSON
- **WHEN** the file is not valid JSON
- **THEN** all defaults apply and one warning names the file and the parse error

#### Scenario: Bad interval
- **WHEN** `animation.intervalMs` is `"fast"`
- **THEN** the default interval applies and one warning names `animation.intervalMs`

#### Scenario: Interval out of range
- **WHEN** `animation.intervalMs` is 2147483648
- **THEN** the default interval applies and one warning names `animation.intervalMs`

#### Scenario: Frame with a newline
- **WHEN** `animation.frames` contains `"a\nb"`
- **THEN** the default spinner applies and one warning names `animation.frames`
