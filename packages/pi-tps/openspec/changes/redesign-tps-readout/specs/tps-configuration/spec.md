# Spec Delta

## MODIFIED Requirements

### Requirement: Configuration schema
The file SHALL be a JSON object with optional keys: `enabled` (boolean), `persist` (boolean, default true), `calibration` (boolean, default true), `separator` (non-empty string without control characters, default ` | `), `baseColor` (colour, default `dim`), `separatorColor` (colour, default `borderMuted`), `burstColor` (colour, default `mdLink`), `animation` ({ `enabled`: boolean, `intervalMs`: number from 50 to 1000, `frames`: non-empty strings without control characters }), `tps` and `ttft` (metric settings), and `overrides` (object mapping match keys to objects with optional `tps` and `ttft` metric settings). Metric settings SHALL be an object with optional `mode` (`"relative"` or `"absolute"`, default `"relative"`), `relative` and `absolute` (threshold lists). Any other key, including the removed `labels`, `summaryMode` and `thresholds`, SHALL produce one warning and be ignored.

#### Scenario: Partial file
- **WHEN** the file contains only `{ "separator": " · " }`
- **THEN** every other setting keeps its default

#### Scenario: Symbol labels
- **WHEN** the file contains `{ "labels": "symbols" }`, a setting this version removed
- **THEN** one warning names `labels` and the readout keeps its single notation

#### Scenario: Unknown label style
- **WHEN** the file contains `{ "labels": "emoji" }`
- **THEN** one warning names `labels` as an unknown setting and nothing else changes

#### Scenario: Unknown mode
- **WHEN** `tps.mode` is `"fast"`
- **THEN** relative mode applies to TPS and one warning names `tps.mode`

#### Scenario: Override in the old format
- **WHEN** an override value is a threshold list instead of an object
- **THEN** one warning names the override key and the override is ignored

#### Scenario: Separator with a newline
- **WHEN** `separator` is `"\n"`
- **THEN** the default separator applies and one warning names `separator`

### Requirement: Threshold list
A threshold list SHALL be an array of `{ "min": number, "color": colour }` entries, sorted by `min` for resolution with entries of equal `min` keeping their file order so that the later one wins; a value takes the colour of the highest `min` not greater than it. Relative lists are in percent, `tps.absolute` in tokens per second and `ttft.absolute` in seconds. The defaults SHALL be `[{min:0,color:"error"},{min:40,color:"warning"},{min:75,color:"success"}]` for both relative lists, `[{min:0,color:"error"},{min:30,color:"warning"},{min:80,color:"success"}]` for `tps.absolute` and `[{min:0,color:"success"},{min:3,color:"warning"},{min:6,color:"error"}]` for `ttft.absolute`.

#### Scenario: Unsorted input
- **WHEN** the list is given as 80, 0, 30
- **THEN** resolution behaves as if it were sorted ascending

#### Scenario: TTFT at a boundary
- **WHEN** the default `ttft.absolute` list colours a TTFT of 2.9 s and one of 3.0 s
- **THEN** 2.9 s is success and 3.0 s is warning

### Requirement: Override precedence
When several override keys match, the single most specific one SHALL apply, with precedence: exact `provider/model`, then `provider/<glob>`, then model-only (exact before glob), then `provider/*`, then `*`. Within one level a more specific pattern (fewer wildcard-matched characters) SHALL win, and among equally specific patterns the first in the file. Every `mode`, `relative` and `absolute` of each metric that the applied override does not set SHALL come from the top-level `tps` and `ttft` settings.

#### Scenario: Exact beats glob
- **WHEN** both `anthropic/claude-sonnet-4` and `anthropic/claude-*` are configured
- **THEN** the exact entry is used for `anthropic/claude-sonnet-4`

#### Scenario: Provider-scoped glob beats model-only
- **WHEN** both `anthropic/claude-*` and `claude-*` are configured
- **THEN** `anthropic/claude-*` is used for `anthropic/claude-opus-4`

#### Scenario: Partial override
- **WHEN** the only matching override sets `tps.absolute` and nothing else
- **THEN** that list replaces the top-level `tps.absolute`, and the TPS mode, the TPS relative list and all TTFT settings come from the top level

#### Scenario: Overrides do not combine
- **WHEN** `anthropic/*` sets `tps.mode` to `"absolute"` and `anthropic/claude-opus-*` sets only `tps.absolute`
- **THEN** for `anthropic/claude-opus-4` the opus override applies alone and the TPS mode is the top-level mode
