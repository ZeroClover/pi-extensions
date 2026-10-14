# Proposal

## Why

The readout shows too much and too little at once: the summary line holds up to ten fields in one of two label styles, yet while a request streams there is no reference to tell whether 48 tok/s is good or bad for this model. A live figure is only meaningful next to what the same model usually does, and the run summary of the last prompt is less useful than a steady session-wide picture.

## What Changes

- **BREAKING** The readout compares the request in flight with the session so far. Waiting and streaming show the live TPS and TTFT followed by the serving model's smoothed average in parentheses; working shows the averages alone, then the run's progress; after a run settles the line shows only averages and session totals. The rule "never show an average mid-run" is deliberately reversed.
- Averages are kept per provider and model and smoothed so that a single slow or fast request barely moves them (the mean of the first ten samples, then an exponential moving average with weight 0.1 whose samples are clamped to between a third of and three times the current average; only positive samples count). They are rebuilt from the run records on the branch, so they survive resume, `/reload` and `/tree`.
- **BREAKING** After a run settles every figure besides the averages is a session total over all runs on the branch: run count and total run time, requests, input with cache share, visible output, thinking tokens and cost. The last run's own figures are no longer shown.
- **BREAKING** One fixed vocabulary replaces the `text` and `symbols` label styles: `TPS` after the rate, `TTFT` before the time, `x̄` before every average, `✓` / `✗` coloured for the last run's outcome, `↑` input, `◎` cache share, `↓` visible output, `⠿` thinking, `N➤` requests, `↯` before a burst rate, `N runs in <duration>` for the session's run count and time. The `stall` field and the `~` estimate marker are no longer shown (stalls are still measured and still excluded from the TPS).
- Fields are separated by ` | ` by default; the separator is configurable and drawn in its own, fainter colour.
- **BREAKING** TPS and TTFT are coloured in one of two modes per metric: `relative` (default), by the live value as a percentage of the model's average (TTFT as average over live, so faster than usual reads high), with default bands ≥75 % success, ≥40 % warning, below error; or `absolute`, by the value itself as today (TPS in tok/s, TTFT in seconds, default success below 3 s, warning below 6 s, error from 6 s). Relative mode falls back to the absolute thresholds while the model has no average for the metric, and for TPS while its only average is a burst throughput. Averages, labels outside the live figures and every other field use the base colour; TTFT stays uncoloured while a hidden thinking phase is open; `↯` uses `mdLink`.
- **BREAKING** Configuration: `labels`, `summaryMode` and the top-level `thresholds` are removed; `tps` and `ttft` nodes each hold `mode`, `relative` and `absolute` threshold lists; `overrides` values become `{ "tps"?, "ttft"? }` with the same nodes; new keys `separator`, `separatorColor`, `burstColor` and `calibration` (false disables token calibration: live counts use the raw estimate and nothing is read from or written to the calibration directory).
- **BREAKING** `/tps` only toggles visibility; `/tps mode` and its completions are removed.
- **BREAKING** The `pi-tps:status` snapshot changes shape: the `run`, `session` and `empty` phases become one `idle` phase carrying session totals, the last run's outcome and the current model's averages; live and working snapshots carry the averages. `pi-tps:telemetry` and `pi-tps:run` payloads and the persisted run record keep their shape and version 2; request records gain an optional `requested` model when the selected model differs from the serving one.

Example lines (current model averaging 52.3 tok/s and 1.1 s TTFT):

```text
⠋ - TPS | TTFT 1.4s                                                    first request of a model: no average, absolute colours
⠹ - (x̄52.3) TPS | TTFT 2.0s (x̄1.1s) | 2➤                               waiting for the first token of the run's second request
⠼ 68.3 (x̄52.3) TPS | TTFT 0.6s (x̄1.1s) | ↓1.2K | ⠿1.9K 4.0s | 2➤        streaming
⠧ - (x̄52.3) TPS | TTFT 4.2s (x̄1.1s) | ⠿4.0s                            hidden thinking, TTFT uncoloured
⠇ x̄52.4 TPS | TTFT x̄1.0s | run 12.3s | 1➤ | ↓1.6K                       working: averages, then this run's progress
✓ x̄52.4 TPS | TTFT x̄1.0s | 3 runs in 4m 12s | 14➤ | ↑40K ◎88% | ↓6.2K | ⠿2.1K | $0.050
✗ x̄52.1 TPS | TTFT x̄1.0s | 4 runs in 4m 17s | 15➤ | ↑46K ◎89% | ↓6.3K | ⠿2.1K | $0.054
✓ x̄↯225.0 TPS | TTFT x̄4.0s | 2 runs in 9.1s | 2➤ | ↑6.2K | ↓1.8K | $0.0040
- TPS | TTFT -                                                          nothing measured on this branch
```

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `tps-readout`: fixed field vocabulary replaces the label styles and symbol set; live and working states show averages; colouring gains relative and absolute modes for TPS and TTFT; the idle state shows session totals with the current model's averages; `/tps mode` and the summary mode are removed; number formatting examples follow the new vocabulary.
- `tps-configuration`: new schema (`tps` / `ttft` nodes, `separator`, `separatorColor`, `burstColor`, `calibration`; `labels`, `summaryMode`, `thresholds` removed), threshold lists per metric and mode, override values per metric.
- `telemetry-history`: per-model smoothed averages and session totals replace the run and session aggregates; reconstruction rebuilds them; request records name the selected model when it differs from the serving one; the status snapshot changes shape.
- `token-estimation`: live counts carry no uncalibrated marker; calibration can be disabled.
- `request-measurement`: settled, burst and aborted requests feed the per-model averages and session totals instead of the run and session TPS; aborted requests no longer contribute to any average. Measurement itself (stall and burst detection) is unchanged; every existing record field is unchanged, and records gain an optional `requested` model.

## Impact

- Code: `src/format.ts` and `src/render.ts` (new line layout, colouring), `src/config.ts` (schema, resolution), `src/aggregate.ts` (session totals replace run and session aggregates), `src/averages.ts` (new: per-model averages and current-model tracking), `src/telemetry.ts` (snapshot types), `src/measurement.ts` (requested model on records, snapshot without estimate flags) and `src/run.ts` (working snapshot without the estimate flag), `src/index.ts` (event forwarding, calibration switch), `src/command.ts` (toggle only), `src/constants.ts`; their tests.
- Docs: the package `README.md` (introduction, readout, fields, measurement, configuration with the example config that `test/config.test.ts` loads, limitations, event bus), the package `description` in `package.json`, and the root `README.md` table row.
- Users: existing `pi-tps.json` files with `labels`, `summaryMode`, `thresholds` or array-valued overrides get one warning per key and fall back to defaults until rewritten. Session files need no migration.
- Event-bus consumers of `pi-tps:status` must adapt to the new snapshot shape.
- No new dependencies.
