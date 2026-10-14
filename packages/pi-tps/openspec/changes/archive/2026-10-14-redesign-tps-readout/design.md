# Design

## Context

See proposal.md for the motivation and the example lines; the specs hold the observable behaviour. Today `src/format.ts` turns a `StatusSnapshot` into segments in one of two label styles, `src/render.ts` paints them with one threshold list, and `src/aggregate.ts` computes run and session aggregates (one generation-time-weighted TPS over all models) from the `RunRecord`s on the branch. `src/index.ts` keeps the runs, the active model (`model_select`) and the live thresholds; it builds a `CalibrationStore` on every session start.

Every input the new readout needs already exists in the version-2 records: `provider`, `model` (the serving model named by `message_start`), `outcome`, `burst`, `tps`, `throughputTps`, `ttftMs`, token counts, `cost`, and the run's `elapsedMs` and `aborted`. The only addition is an optional `requested` model on request records, needed to pick the current model behind a virtual model (see "The current model").

## Goals / Non-Goals

**Goals:**
- Derive averages and totals from the records alone, so resume, `/reload`, `/tree` and `persist: false` need no extra state.
- Keep formatting and colour decisions pure and testable without Pi.

**Non-Goals:**
- No change to measurement, burst detection, stall detection, estimation or the calibration file format, beyond the optional `requested` field on request records.
- No user-tunable smoothing parameters, no configurable outcome-marker colours or symbols.
- No merging of several matching overrides.
- No migration of old configuration keys beyond the warning.

## Decisions

### Averages are a replay over the records

A new module (`averages.ts`) holds a small state object with `rebuild(records)`, `fold(record)`, `current(selectedModel)` and `of(provider, model)`. It folds request records into a map keyed by `calibrationKey(provider, model)`; each entry holds up to three smoothed values (`tps`, `burstTps`, `ttftMs`), each with its sample count. `index.ts` only forwards events: it calls `rebuild` on `session_start` and `session_tree` with the request records of the branch's runs, `fold` for each newly recorded request at `message_end` before publishing (so the working readout includes it), and asks `current` with its selected model whenever it builds an idle or working snapshot. Keeping the logic in the module lets the tests drive it directly, as `docs/conventions.md` asks, instead of mocking `ExtensionAPI`. The replay is linear in the number of request records and runs only on those two events.

Alternative: persist the averages in their own entry or file. Rejected: a second source of truth would diverge from the records on `/tree` and add a format to version.

### Smoothing: a short mean, then a clamped moving average

The first ten samples form their plain arithmetic mean, so the average has no bias toward the first sample and a slow cold-start request is diluted within a few requests. From the eleventh sample on, the sample is clamped to `[avg/3, 3·avg]` and folded in with weight 0.1, an exponential average whose memory is about the last twenty requests; one outlier then moves the average by at most +20 % or −6.7 %, while a genuine lasting change still converges within a few dozen requests. Clamping during the first ten samples was rejected: a slow first request would anchor the average for dozens of requests. Only positive samples count, because an average of 0 would clamp every later sample to 0 and make the relative percentage undefined; a TTFT rounds to 0 when the first token arrives within 0.5 ms, and a rate is 0 when a request reports no output. The constants (10 samples, weight 0.1, factor 3) live in `constants.ts`.

Alternatives: the current cumulative generation-time-weighted mean is the steadiest but never forgets, so an average from last week's provider load dominates; a fixed window of N requests drops samples abruptly, so the average jumps when an outlier leaves the window; a plain EMA with α = 0.1 from the start lets the first sample dominate the first ten requests. Weighting samples by generation time was dropped: the 1 s minimum already keeps the shortest, noisiest requests out, and per-request weights keep the rule explainable.

### Which requests feed which average

Only settled requests count: an aborted request stops at an arbitrary point, and its partial rate or missing TTFT would bias the model's figure. A settled request with a `tps` (non-burst, generation time ≥ 1 s, as the record already defines it) feeds the TPS average; a burst request feeds `burstTps` from `throughputTps`; every settled request with `ttftMs` feeds the TTFT average, bursts included, because their first token really arrived that late. Each sample must be positive. The readout shows the burst average only while the TPS average is absent.

### The current model

The current model is a pure function of the selected model and the last request record on the branch: the serving model of that record when it was sent under the selected model, else the selected model. The selected model is what Pi already tracks (`ctx.model` at `session_start`, then `model_select`), and Pi restores it on resume and keeps it across `/reload` and `/tree`, so the function needs no state of its own: no replay of `model_change` entries, no comparison of timestamps, and no special case for `/tree` or a selection made while tools execute. The serving-model exception keeps virtual models useful, because the selected virtual id never has records of its own.

To evaluate "sent under the selected model", a record carries `requested: { provider, model }` when the model selected at `before_provider_request` differs from the serving model that `message_start` named. `Measurement` already holds both: the request context starts with the selected model and is replaced at `message_start`. The field is optional, so the record stays at version 2 and older records read as sent under their serving model. With `persist: false` the averages and totals come from this runtime's runs and the last record is this runtime's last one.

The current model is only the key for the idle and working averages. `index.ts` keeps `activeModel`, the selected model, for `before_provider_request`, so a new request starts under the selected model as today; live snapshots then use the request's own provider and model, which `message_start` switches to the serving model. The `model_select` handler now publishes, so the idle readout changes at once.

### Snapshot shape

```ts
interface Averages { tps?: number; burstTps?: number; ttftMs?: number }

interface LiveSnapshot {            // phase "waiting" | "streaming"
  phase; provider; model; request; elapsedMs; ttftMs?; liveTps?;
  outputTokens; thinkingTokens?; thinkingMs?; thinking;
  average: Averages;
}
interface WorkingSnapshot { phase: "working"; elapsedMs; requests; outputTokens; average: Averages }
interface SessionTotals {
  runs; elapsedMs; requests; inputTokens; cacheReadTokens; cacheWriteTokens;
  visibleOutputTokens; thinkingTokens; cost?; lastAborted: boolean;
}
interface IdleSnapshot { phase: "idle"; average: Averages; session?: SessionTotals }
```

The `calibrated`, `thinkingCalibrated` and `tpsCalibrated` flags (computed in `Measurement.snapshot`) and the `estimated` flag of the working snapshot (computed in `RunTracker.snapshot`) leave the snapshot because nothing displays them any more; records keep `estimated`. `RunTracker` does not know models, so `index.ts` attaches `average` to the working snapshot, as it does to live snapshots. `Aggregate`, `RunSummary`, `SessionSummary`, `SummaryMode` and the `run` / `session` / `empty` phases are removed. `summarizeRun` and `summarizeSession` are replaced by `sessionTotals(runs)`; `visibleOutput` stays, while `tokensEstimated` and `thinkingEstimated` lose their last callers and are removed.

### Colour as a role, decided in format

`format.ts` returns segments that carry a colour role instead of a raw `tps` number: `base`, `separator`, `burst`, `success`, `error`, or a resolved threshold colour. A pure function picks the live colour:

- relative mode with an average of that metric: `percent = live / avg × 100` for TPS, `avg / live × 100` for TTFT (a live TTFT of 0 counts as the highest band);
- otherwise, and for TPS whose only average is a burst throughput: the absolute list with TPS in tok/s and TTFT in seconds;
- base colour for a `-` live value, and for the live TTFT while `ttftMs` is absent and `thinking` is `hidden`.

`render.ts` maps roles to `ColorSpec`s (`baseColor`, `separatorColor`, `burstColor`, theme `success` / `error`) and joins with the configured separator. Splitting the TPS field into `68.3` (live colour), ` (x̄52.3)` (base) and ` TPS` (live colour) keeps the label in the live colour as specified.

### Configuration resolution

`TpsConfig` gains `calibration`, `separator`, `separatorColor`, `burstColor`, and `tps` / `ttft: MetricSettings { mode; relative: Threshold[]; absolute: Threshold[] }`. An `Override` keeps its match rule and holds `Partial<MetricSettings>` per metric. `resolveMetrics(config, provider, model)` picks the single best override with the existing precedence and fills each unset leaf from the top level. `index.ts` resolves the metrics for the live model on `before_provider_request` and `message_start`, as it resolves thresholds today. The idle and working readouts never colour by thresholds, so they need no resolution.

The parser reuses `parseThresholds` and the warning style; `labels`, `summaryMode` and `thresholds` fall into the existing unknown-key warning, and an array-valued override value gets one warning naming the key. `separator` reuses the control-character check of animation frames.

### Calibration switch

With `calibration: false`, `index.ts` creates no `CalibrationStore`: `ratios` are `{}` (factor 1), no samples are applied, and `close` has nothing to flush, so the directory is neither read nor written and its warnings cannot appear. The measurement code is unchanged; it already treats missing ratios as factor 1.

### Command

`parseTpsCommand` accepts only an empty argument; anything else is `invalid` and shows the usage `Usage: /tps (show or hide the readout)`. Argument completions are removed.

## Risks / Trade-offs

- [`x̄` is `x` plus a combining macron] → pi-tui counts it as one column, so truncation stays correct; a terminal font that draws the macron off-centre only looks slightly off. The README names it so a user can recognise it.
- [`↑ ↓ ◎` are East Asian ambiguous-width characters (`➤` is neutral; the unknown value is the ASCII `-` rather than the ambiguous-width em dash U+2014)] → terminals configured to draw ambiguous characters double-wide will misalign the footer, as they already do with today's `↑ ↓`. pi-tui counts one column each; documented in the README limitations.
- [Breaking configuration and snapshot shape] → one warning per removed key and fallback to defaults; the proposal marks the snapshot change as breaking. Release intent `minor`, as the package is below 1.0.
- [Relative colours hide an absolutely slow model] → that is the purpose of the mode; `absolute` remains available per metric and per model.
- [Hidden-thinking models fold thinking time into TTFT] → their TTFT average includes the same thinking time, so relative colours stay comparable within the model.

## Migration Plan

No session data migrates: the averages are recomputed from the existing version-2 records on the first session start after the update. Users with `labels`, `summaryMode`, `thresholds` or array-valued overrides see one warning per key; moving `thresholds` to `tps.absolute` (and setting `tps.mode` to `absolute`) restores the old colouring. Rolling back to the previous version reads the same records unchanged.
