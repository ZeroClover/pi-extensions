# Tasks

## 1. Phase events and thinking time (`src/measurement.ts`, `src/index.ts`)

- [ ] 1.1 Replace `contentDelta` with a `phaseEvent` mapper covering `thinking_start`, `thinking_end`, `text_start`, `toolcall_start` and the three delta kinds, forward it from `message_update` in `src/index.ts`; verify `test/measurement.test.ts` maps each event type and ignores `start`, `*_end` of text and tool calls, and empty deltas
- [ ] 1.2 Track thinking blocks (open at `thinking_start` or an orphan thinking delta, close at `thinking_end`, any non-thinking event or `end()`), record `thinkingMs` as summed wall time and `thinking: none | hidden | streamed`; verify tests for "Summary in chunks" (11 s, no stall), "Hidden reasoning" (7.5 s), "Start synthesised from the first chunk" (6 s, adapter-style: start and delta in the same tick), "Several thinking phases" (5 s), "Phase without end event" (3.5 s) and "No thinking" (absent)
- [ ] 1.3 Restrict stall detection to consecutive output deltas; verify tests "Silence while thinking" records no stall and "Server pause mid-stream" still records 1.2 s
- [ ] 1.4 Snap TTFT to the open block's `thinking_start` on the first non-empty thinking delta, keep the live count-up until a delta arrives; verify tests "Thinking arrives first" (1.1 s recorded, 1.3 s live until then), "Thinking block without deltas" (8.2 s) and "Empty start events" (0.9 s)

## 2. Settlement and record schema (`src/measurement.ts`, `src/telemetry.ts`, `src/burst.ts`)

- [ ] 2.1 Compute `generationMs`, `generatedTokens` (`usage.output` with an observed phase, else minus the reported reasoning), `tps = generatedTokens / generationMs` (estimate fallback marked estimated), keep `outputTps` / `thinkingTps`, derive the breakdown only from a positive `usage.reasoning`, estimate thinking tokens for streamed thinking otherwise, and keep a count without a phase as tokens without duration; verify tests for every scenario of "Settlement from provider usage" (80 / 80 / ≈52.2 / 300 tokens → 100 / 100 / capped / no TPS under 1 s / tool call over 3.4 s)
- [ ] 2.2 Build the burst timeline from output deltas only, compare the batch threshold with the exact visible output (no thinking phase or positive `usage.reasoning`) or else with the calibrated output-stream estimate, and feed the rate criterion with `tps`; verify `test/burst.test.ts` and `test/measurement.test.ts` cover "Successful request without deltas" (still burst), "Hidden reasoning then a short tool call" (not burst), "Short tool call after unreported thinking" (624 / 0 / thinking estimate 500 / one 20-token batch: not burst, has a rate, calibrates), "Chunked summary then a tool call" (not burst, the exact timeline `[2000, 6000, 11000, 12000]` from the review), "Summary delivered in one piece" (not burst), "Buffered chain of thought and answer" (burst), "Proxy flush after a long wait" (still burst) and "Implausible rate" (burst)
- [ ] 2.3 Move `RequestRecord` to `thinking`, `generationMs`, `tps`, set `TELEMETRY_VERSION = 2`, update `parseRequestRecord` / `parseRunRecord`, extend `LiveSnapshot` with `thinking`, `thinkingCalibrated`, `tpsCalibrated`; verify `test/telemetry.test.ts` (new) round-trips a version-2 record, rejects version 1 and rejects malformed `thinking` values

## 3. Aggregation (`src/aggregate.ts`, `src/run.ts`)

- [ ] 3.1 Qualify records by `generationMs ≥ 1 s`, sum `generatedTokens` over `generationMs`, keep the aborted and burst fallbacks, sum `thinkingMs` from the phase time; verify `test/aggregate.test.ts` covers "Thinking counts" (≈84.8 with both requests), "Reasoning count without a phase" (the phase-less request alone: 100 for the request, its run and a one-run session; mixed with the 80-TPS thinking request: ≈83.3 for the run and the session), "Aggregate generation rate" (≈108.3), "Span just under one second", "Hidden and streamed thinking" (1000 tokens marked estimated, 22 s), "Aborted-only run" and "Mixed runs" (75)
- [ ] 3.2 Confirm `RunTracker` and `runsFromEntries` ignore version-1 entries; verify a test resuming a branch with version-1 entries yields the empty snapshot

## 4. Live generation rate (`src/measurement.ts`)

- [ ] 4.1 Record the phase of every delta in the timeline and implement the interval-attributed window (prorated edge interval, first delta of a phase and output stalls skipped, trailing time per phase rule, availability at 1.5 s of counted time); verify tests "Early in the stream", "First chunk is large" (40 tok/s flat from 1.5 s), "Window shorter than 5 s" (50), "Window at full length" (80), "Delta straddling the window edge" (12 tokens, 0.4 s), "Stall inside the window" (60 after a 2 s pause), "Long pause" (60 at a 3.5 s pause, unavailable at 3.6 s), "Resuming after a pause" (3 s pause: never unavailable; 4 s pause: back after 0.5 s of resumed output), "Thinking phase" (160 with ratio 8) and "Hidden thinking phase" (unavailable)
- [ ] 4.2 Apply the output and thinking ratios separately in the live window and expose the calibration flags in the snapshot; verify tests for "Calibrated model" (120), "Output calibrated, thinking not" (marker on TPS and think while thinking tokens are in the window, gone once only output remains)

## 5. Thinking calibration (`src/calibration.ts`, `src/constants.ts`)

- [ ] 5.1 Add the thinking ratio per entry with clamp `[0.25, 100]`, the kind-aware `update` and `ratio` API, file format version 2 that ignores older formats without a warning; verify `test/calibration.test.ts` covers "Full chain of thought" (≈1.05), "Summary" (50), clamp at 100, "No reasoning count" (no update), "Independent of the output ratio", "Older file format" and the existing concurrency scenarios on the version-2 format
- [ ] 5.2 Produce the output sample from the total when `usage.reasoning` is not positive and thinking was streamed, and the thinking sample only for streamed thinking with a positive count; verify tests "Reasoning reported as zero with streamed thinking" (1.2 from 900 / 750) and "Reasoning breakdown" (1.2 from 300 / 250)

## 6. Readout (`src/format.ts`, `src/render.ts`)

- [ ] 6.1 Show the live generation rate during streamed thinking, the duration-only `think` field for an open hidden phase with `TPS —`, and the per-figure markers; verify `test/format.test.ts` covers "Hidden thinking in progress" (`TPS — · TTFT 4.2s · think 4.0s` / `»— ⇥4.2s ✻4.0s`), "Streaming a thinking summary" and "Uncalibrated warm-up" in both styles
- [ ] 6.2 Render the summary from `tps`, `think N` without duration for a count without a phase; verify tests "Thinking model" (`TPS 80.0 tok/s · … · out 800 · think 400 5.0s`) and "Reasoning count without a phase" (`think 900`)
- [ ] 6.3 Add a pipeline test (phase events → `Measurement` → burst → `RunTracker` → calibration → `summarizeRun` → `formatSnapshot`) for four model kinds: full chain of thought with `reasoning 0`, Responses-style hidden reasoning, chunked summary with a reasoning count followed by a short tool call (not burst, contributes to the run TPS, updates the thinking ratio), and a reasoning count without a phase mixed with a normal thinking request; verify each ends in the expected summary line, that a one-request run and a one-run session show the request's own rate, and that the mixed run and its session show the duration-weighted rate

## 7. Documentation and verification

- [ ] 7.1 Rewrite the README sections "Reading the readout" (TPS, think, markers), "Measurement" (phases, thinking time, live window, settlement, burst input, calibration with the thinking ratio, version 2 files and records, the backend table from design.md Context) and "Limitations" (count without phase, backends that synthesise `thinking_start` from the first chunk so their rate is an upper bound, buffered chain of thought with a short answer, first-chunk discrepancy, thresholds), and the root README table line; verify every statement against the code and that the example config block still loads without warnings in `test/config.test.ts`
- [ ] 7.2 Run `pnpm check` and the load smoke test from `docs/workflow.md`; verify both pass
- [ ] 7.3 Live check in the TUI with one backend of each kind available (an OpenAI-compatible full chain-of-thought model, a Responses-API reasoning model with and without summaries, an Anthropic thinking model): compare the summary's `out`, `think` and TPS with the `usage` in the session file and confirm the live TPS neither starts high nor shows `—` while a summary streams; record the observed lines in the final report

## Workflow follow-up

- Archive the change after review (`openspec archive count-thinking-in-tps` from `packages/pi-tps`).
- Commit as `feat(pi-tps): count thinking in the generation rate`.
