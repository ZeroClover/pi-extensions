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

## Workflow follow-up

- Archive the change after review (`openspec archive add-tps-readout` from `packages/pi-tps`), then commit as `feat(pi-tps): add live TPS readout`.
