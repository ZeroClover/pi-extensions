# Tasks

## 1. Package scaffold

- [x] 1.1 Create `packages/pi-tps/package.json` per docs/workflow.md (name `pi-tps`, `pi.extensions: ["./src/index.ts"]`, peers `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` at `"*"`, dependency `tokenx` caret-pinned); run `pnpm install` from the root and verify the lockfile lists `tokenx` under the package
- [x] 1.2 Create `src/constants.ts` with every threshold named in design.md D3/D4/D6/D7 and `src/clock.ts` with the `Clock` interface and `performance.now` default; verify `pnpm typecheck` passes with an empty `src/index.ts` default export

## 2. Token estimation and calibration

- [x] 2.1 Implement `src/estimator.ts` (tokenx wrapper, per-delta estimate) and verify `test/estimator.test.ts` covers empty input, English, Chinese and JSON tool-argument deltas with the 30 % tolerance scenario from spec `token-estimation`
- [x] 2.2 Implement `src/calibration.ts` (key derivation, EMA update, clamp, min-sample guard, load/save with warnings via an injected file layer) and verify `test/calibration.test.ts` covers first sample, convergence, clamping, corrupt file and unwritable file scenarios

## 3. Measurement core

- [x] 3.1 Implement `src/measurement.ts` state machine with injected clock: waiting/streaming transitions, TTFT, time to first visible text, delta timeline with per-kind prefix sums, stall accounting, live window TPS, retry reset, turn gating; verify `test/measurement.test.ts` reproduces every scenario under "Time to first token", "Time to first visible text", "Thinking and output are measured separately", "Live output TPS", "Stall detection", "Automatic retry" and "Cache warming while idle" from spec `request-measurement` using synthetic timelines
- [x] 3.2 Implement `src/burst.ts` and verify `test/burst.test.ts` covers the batch, cluster and rate criteria, the stall-then-flush pattern, and the several-events-per-read and genuine-fast-streaming negative cases
- [x] 3.3 Implement settlement in `measurement.ts` (D5 formulas, reasoning fallback, burst throughput, abort/error/deferred outcomes, cost gating, `durationMs` cross-check) and verify tests cover "Settlement from provider usage", "Burst requests report throughput", "Aborted requests", "Errored and deferred requests" and "Elapsed time and cost"
- [x] 3.4 Implement `src/telemetry.ts` (versioned `TelemetryRecord`, `StatusSnapshot`, channel constants) and `src/aggregate.ts`; verify `test/aggregate.test.ts` covers the mixed-records scenario and unknown-version skipping from spec `telemetry-history`

## 4. Configuration

- [x] 4.1 Implement `src/config.ts`: defaults (including `persist: true`), loader with per-field warnings, colour validation (theme token set + hex regex), threshold sorting; verify `test/config.test.ts` covers missing file, partial file, invalid JSON, bad interval, unknown token, non-boolean `persist` and unsorted thresholds
- [x] 4.2 Implement override key parsing, `*` glob compilation, specificity ranking and resolution order in `config.ts`; verify tests cover every scenario under "Override match keys" and "Override precedence" plus case-insensitivity
- [x] 4.3 Document the configuration file in `packages/pi-tps/README.md` (all keys, defaults, override examples, colour values) and verify the documented example file loads without warnings in a unit test

## 5. Readout rendering

- [x] 5.1 Implement `src/format.ts` (number/duration/token formatting, phase-specific field layouts, markers, cache folding) and verify `test/format.test.ts` covers "Displayed fields", "Markers" and each phase from spec `tps-readout`
- [x] 5.2 Implement `src/render.ts` (threshold colour selection, theme token vs hex application through a minimal `Theme`-like interface) and verify `test/render.test.ts` covers value between thresholds, value below the lowest threshold and hex rendering
- [x] 5.3 Implement `src/ticker.ts` with injectable timer functions and verify `test/ticker.test.ts` shows one render per interval under a high synthetic delta rate, change-only renders when animation is disabled, and no timer when idle

## 6. Extension wiring

- [x] 6.1 Implement `src/index.ts`: register events (`session_start`, `session_shutdown`, `session_tree`, `turn_start`, `turn_end`, `before_provider_request`, `after_provider_response`, `message_start`, `message_update`, `message_end`, `agent_end`, `model_select`), wire core → ticker/render → `setStatus` guarded by `ctx.mode === "tui"`, persistence via `pi.appendEntry` gated by `persist`, reconstruction from `getBranch()` that skips foreign `customType` values, calibration load/save, event-bus emits and `pi-tps:request`; verify the RPC load smoke test from docs/workflow.md exits 0 and lists `/tps`
- [x] 6.2 Implement the `/tps` command (toggle, `mode`, `mode last|session`, argument completions) and verify in a live `pi -ne -e ./packages/pi-tps` session that each form changes the footer immediately
- [x] 6.3 Live verification in a TUI session against at least two providers (one with `usage.reasoning`, one without): waiting → streaming → settled phases render, colours follow thresholds, Escape produces the abort marker, `/reload` restores the last readout and session averages, `/tree` to another branch recomputes them; record the observed readouts in the final report
- [x] 6.4 Verify non-TUI behaviour: `pi -ne -e ./packages/pi-tps --mode rpc` and `--print` runs emit no status text and still append `pi-tps` entries to the session file

## 7. Documentation and integration check

- [x] 7.1 Complete `packages/pi-tps/README.md` (purpose, install, `/tps` command table, readout glyph legend, measurement definitions and limitations from design.md, event-bus contract) and add the `pi-tps` row to the root `README.md` table; verify both render the same command and setting names as the code
- [x] 7.2 Run `pnpm check` from the repository root and the load smoke test; verify both pass with no new warnings

## 8. Review fixes (REVIEW.md)

- [x] 8.1 F1: rework `src/estimator.ts` to keep the open trailing segment and commit complete segments (long open tails in 256-character chunks); verify `test/estimator.test.ts` covers "Long digit run" in 1, 2, 4 and 128-character deltas plus identifiers, punctuation runs, English, CJK and JSON within 2 % of the whole-text estimate, and the existing 30 % fixtures
- [x] 8.2 F2: let `Measurement` replace the request identity (provider, model, ratio) from the assistant `message_start` without moving the timing origin, and resolve thresholds from it in `index.ts`; verify `test/measurement.test.ts` covers "Virtual model"
- [x] 8.3 F3: add an exclusive lock-file section to `src/files.ts` and use it for the calibration read-merge-write; verify `test/calibration.test.ts` covers "Concurrent sessions" with an injected file layer that interleaves two stores, for different keys and the same key
- [x] 8.4 F4: keep keys whose write failed authoritative over the disk copy until a write succeeds; verify "Unwritable file" (ratio keeps converging) in `test/calibration.test.ts`
- [x] 8.5 F6 and configuration edges: `animation.intervalMs` limited to 50–1000, frames without control characters, equal-`min` and equal-specificity tie rules; verify `test/config.test.ts` covers "Interval out of range", "Frame with a newline" and both tie rules
- [x] 8.6 Measurement edges: sanitise usage counts (negative or non-finite → 0), cap reasoning at the output, mark successful requests without deltas as burst, reject records with negative counts; verify "Inconsistent usage" and "Successful request without deltas" in `test/measurement.test.ts` and the record validation in `test/aggregate.test.ts`
- [x] 8.7 Calibration rules from spec `token-estimation`: verify `test/calibration.test.ts` and `test/measurement.test.ts` cover "Reasoning breakdown", "Outlier as first sample", "Outlier after calibration" and "Tiny response"; F5 (aborted TTFT), S2 (stale TPS fallback), S3 (visible output) and the README `/tree` statement are resolved by section 9

## 9. Run-level summary and label styles

- [x] 9.1 Extend `src/telemetry.ts` with the versioned run record (`startedAt`, `elapsedMs`, `aborted`, `requests`), its parser, the `working` live phase, run and session snapshot shapes and the `pi-tps:run` channel; verify `test/aggregate.test.ts` round-trips a run record and skips unknown versions and foreign entries
- [x] 9.2 Rewrite `src/aggregate.ts` around one aggregation over request records (aggregate generation rate over settled non-burst requests with the 1 s minimum, burst throughput fallback, mean TTFT over non-aborted requests, sums of tokens, stalls, thinking and cost) used for runs and sessions, plus reconstruction of the run list from entries; verify tests cover "Token-weighted TPS", "Burst and aborted requests", "Mixed runs" and the persistence-off case from spec `telemetry-history`
- [x] 9.3 Implement `src/run.ts` (start at the first `agent_start`, join later ones, collect records, settle with elapsed time and the aborted flag, discard runs without records) with an injected clock; verify `test/run.test.ts` covers "Tool calls", "Automatic retry after an error" and the empty run
- [x] 9.4 Add the `labels` key to `src/config.ts`; verify `test/config.test.ts` covers "Symbol labels" and "Unknown label style"
- [x] 9.5 Rewrite `src/format.ts` with one field layout per phase (waiting, streaming, working, run summary, session, empty) printed in the text or symbol style, and the new number and duration formatting; verify `test/format.test.ts` covers every phase in both styles and every scenario under "Label styles", "Symbol set", "Readout phases", "Summary only after the run settles" and "Number formatting"
- [x] 9.6 Rewire `src/index.ts`: `agent_start`/`agent_settled` drive the run and the ticker, request settlement adds records without rendering a summary, the summary renders and persists at `agent_settled`, `pi-tps:telemetry` per request and `pi-tps:run` per run; verify `pnpm check` and the RPC load smoke test
- [x] 9.7 Update `packages/pi-tps/README.md` (readout in both styles, symbol legend, run semantics, `labels` setting, per-run persistence, event channels) and the root README description; verify the documented names match the code and the README example config still loads without warnings
- [x] 9.8 Live verification in a TUI session: a prompt with tool calls shows waiting, streaming and working phases and a single summary after the run settles; both label styles render; Escape gives the aborted summary; `/reload` and `/tree` restore the last run and session figures; print and RPC modes append one `pi-tps` entry per run and send no status text; record the observed readouts in the final report
- [x] 9.9 Run `pnpm check` from the repository root and the load smoke test; verify both pass with no new warnings
- [x] 9.10 Expand the README into a reference for readers: what the line shows in each state, every field in both styles with the states it appears in and what it measures, the markers and colours, and one summary line explained field by field; verify each statement against `src/format.ts`, `src/aggregate.ts` and `src/run.ts`

## 10. Second review fixes (REVIEW.md)

- [x] 10.1 R4: round stored `outputMs` and `thinkingMs` down; verify a cross-module test (Measurement → JSON round-trip → aggregate) for spans of 999.49, 999.5, 999.99 and 1000 ms and "Span just under one second"
- [x] 10.2 R1: keep only the last segment open and return signed increments; verify `test/estimator.test.ts` covers "Suffix changes a segment's class", "Any delta size" with exact equality (including mixed scripts and long whitespace below 512 characters) and "Over-long segment"
- [x] 10.3 R2/R3: replace the lock with the versioned calibration store (exclusive `link` publish, retry, queued samples replayed on the newest version, prune, flush at shutdown); remove `lock` from `FileLayer`; verify `test/calibration.test.ts` covers "Concurrent sessions", "Concurrent update of one model", "No later update", "Unwritable file" and "Corrupt file", and `test/files.test.ts` the exclusive publish on a real directory
- [x] 10.4 R5: carry estimate provenance for burst throughput and summed tokens, and mark every uncalibrated live estimate; verify a cross-module test (Measurement → RunTracker → summarizeRun → formatSnapshot) for "Estimated summary" and `test/format.test.ts` for "Uncalibrated live figure" and "Uncalibrated warm-up" in both styles
- [x] 10.5 R6: align README and design (aborted fallback, errored requests show the working phase, "aggregate generation rate" instead of "token-weighted", live window includes pauses, calibration directory); verify every statement against the code
- [x] 10.6 Run `pnpm check`, the load smoke test and a live TUI run (tool calls, Escape, `/reload`) and two concurrent print sessions writing calibration; verify the newest calibration version holds both models

## 11. Third review fixes (REVIEW.md)

- [x] 11.1 Calibration ABA: give each sample an id, record the last 512 applied ids per version, apply only unrecorded samples, and treat a sample as stored only when the newest version lists it; verify `test/calibration.test.ts` covers "Writer paused across several publishes" on the memory layer and on a real directory, plus the existing concurrency scenarios without double counting
- [x] 11.2 Arrivals versus corrections: record only the positive part of each estimate increment in the live window and burst timeline, keep corrections in the totals; verify `test/pipeline.test.ts` (real estimator → Measurement → burst → aggregate) covers "Estimator correction at the end" and that the cluster share stays within 100 %
- [x] 11.3 Update README (estimation, burst, calibration files) and run `pnpm check`, the load smoke test and two concurrent print sessions; verify the newest calibration version holds both models

## 12. Fourth review fixes (REVIEW.md)

- [x] 12.1 Replace the bounded sample-id list with per-session sequence numbers: a random session id per store, ordered sample numbers, a `writers` record per version carried forward, exact confirmation, 7-day removal of stale records, own record removed at shutdown, unprovable samples dropped when the own record vanished; verify `test/calibration.test.ts` covers "Large backlog" (512, 513 and 1025 samples, checking samples, ratio and updatedAt after a restart), "Pause after publishing", "Crashed session", "Session paused beyond the retention", the existing concurrency and ABA scenarios, and removal at shutdown
- [x] 12.2 Update README and run `pnpm check`, the load smoke test and two concurrent print sessions; verify the newest version holds the expected samples and no record of the finished sessions

## Workflow follow-up

- Archive the change after review (`openspec archive add-tps-readout` from `packages/pi-tps`), then commit as `feat(pi-tps): add live TPS readout`.
