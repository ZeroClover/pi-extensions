# Proposal

## Why

Pi shows no generation-speed feedback while a model responds. Users cannot tell whether a slow turn is a slow provider, a long prefill, a hidden thinking phase, or a proxy that buffers the stream and flushes it all at once. Existing community extensions each solve one slice (banner at turn end, live footer readout, colour by speed) and none separates thinking from output, calibrates its token estimate against the provider's reported usage, or distinguishes genuine streaming from burst delivery.

## What Changes

- New package `packages/pi-tps`: a Pi extension that measures every assistant API request and shows a live readout in the footer status area (`ctx.ui.setStatus`).
- The summary unit is the agent run (one user prompt: every request, tool call, retry and continuation until Pi settles). Live figures are shown while a request streams and run progress while tools execute; averages are shown only once the run has settled, because per-request averages in the middle of a multi-request run are noise.
- The readout uses plain word labels by default (`TPS 42.5 tok/s · TTFT 1.2s · 18.4s · in 2.9K · out 388`, after monotykamary/pi-tps); a configuration key switches to a compact single-cell symbol set.
- Timing on a monotonic clock: TTFT from the provider request to the first non-empty delta of any kind; separate thinking and output phases; stall detection (gaps of 500 ms or more) that is excluded from the generation-speed denominator.
- Live tokens-per-second over a 5 s sliding window of estimated tokens, with a per-provider/model calibration ratio learned from the provider's `usage.output` at the end of each request and persisted across sessions.
- Burst detection that marks requests delivered as a buffer flush (fake streaming) and shows end-to-end throughput with a burst marker instead of an inflated generation rate.
- Settlement of each request at `message_end`: tokens, thinking share, elapsed time, generation TPS and cost (only when the model has a non-zero price) recomputed from the provider's usage; at `agent_settled` the run summary aggregates its requests (aggregate generation rate, mean TTFT, summed tokens, stalls and cost).
- Colour of the TPS figure driven by configurable thresholds, with global defaults overridable per provider, per model, and per provider/model pair (glob patterns on the model part); values are Pi theme colour tokens or hex colours.
- A single throttled ticker (about 100 ms) drives the spinner and number refresh while a run is active; nothing runs while idle.
- Telemetry is persisted as one session custom entry per run (outside model context, holding the run summary and its request records, `persist: false` disables it) so the readout and the session averages survive resume, reload and `/tree` navigation. The record format is this package's own and is not shared with other TPS extensions.
- Commands: `/tps` toggles the readout; `/tps mode` switches the idle readout between the last run's summary and the session average.
- Event-bus broadcast of each status snapshot, each request record and each run record for other extensions; in non-TUI modes the extension measures and broadcasts but writes nothing to the UI.

## Capabilities

### New Capabilities
- `request-measurement`: timing and rate measurement of agent runs and of each assistant request in them: TTFT, thinking/output phases, live TPS, stalls, burst detection, settlement from provider usage, and behaviour on abort, retry, error and non-agent requests.
- `token-estimation`: estimating streamed token counts from text and calibrating the estimate per provider/model from reported usage, with the calibration persisted across sessions.
- `tps-readout`: the footer presentation: label styles, fields, formatting, colour thresholds, animation, run-level summary, the `/tps` commands, and non-TUI behaviour.
- `tps-configuration`: the user configuration file: location, schema, threshold hierarchy and matching, validation and fallback.
- `telemetry-history`: persistence of per-run telemetry in the session, run and session aggregates, reconstruction on session start and branch change, and the event-bus contract.

### Modified Capabilities
_None; this is the package's first change._

## Impact

- New files under `packages/pi-tps/` (`package.json`, `README.md`, `src/`, `test/`); a new row in the root `README.md` extension table.
- New runtime dependency `tokenx` (heuristic token estimator, zero dependencies) declared in the package.
- Host packages used as peer dependencies: `@earendil-works/pi-coding-agent` (events, UI, `getAgentDir`), `@earendil-works/pi-ai` (message and usage types), `@earendil-works/pi-tui` (`parseColor`, width helpers).
- Pi events consumed: `session_start`, `session_shutdown`, `session_tree`, `agent_start`, `agent_settled`, `turn_start`, `turn_end`, `before_provider_request`, `after_provider_response`, `message_start`, `message_update`, `message_end`, `agent_end`, `model_select`.
- Files written by the extension: `<agent-dir>/pi-tps-calibration/` (numbered versions); files read: `<agent-dir>/pi-tps.json`.
- Session files gain `custom` entries with `customType: "pi-tps"`; they do not enter model context.
