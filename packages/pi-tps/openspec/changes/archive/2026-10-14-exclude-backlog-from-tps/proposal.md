# Proposal

## Why

The live TPS still starts far too high and then decays for about 5 s. Instrumented runs (a debug extension logging every network read of the SSE response next to the deltas pi-tps sees) show why: when an output phase opens, providers deliver a backlog of text generated before the first byte (TTFT, or the whole thinking phase) across several network reads within 100–200 ms. pi-tps excludes only the first arrival of a phase, so the rest of the backlog is counted against a few milliseconds and stays in the 5 s window. Ordinary requests read about 1.5 times their steady rate at the start, on every backend measured (Anthropic API, a relay, an OpenAI Responses model). After hidden or summarised thinking, Claude Opus 5.5 releases 62–75 % of the answer within 100 ms of its first text delta, and the live figure peaks at 544–831 tok/s against a steady rate near 100. The same backlog makes the settlement's cluster criterion classify such normal streams as burst (96 of 1258 recorded requests carry `burstReason: "cluster"`), so they lose their rate and their calibration sample. Two related defects come from the same rules: the live rate drops to 0–20 tok/s during Claude's thinking (a summary arrives in a few chunks separated by seconds of silence that the window counts), and the settled rate of a request without thinking divides the TTFT backlog by no time at all (about 8 % high for a 10 s answer, 27 % for 3 s), so the per-model average the live figure is compared with is biased the other way.

## What Changes

- The live window no longer counts a fixed **backlog window** of 300 ms after every arrival that starts a counted run of intervals (the first delta of a phase, the first delta after an output stall): neither its time nor the tokens of intervals inside it, prorated for an interval that straddles its end. The window is anchored at that arrival and does not move with later arrivals, so a fast genuine stream loses only 300 ms of data and the figure appears 0.3 s later (1.8 s instead of 1.5 s after a phase opens).
- While a thinking phase that has streamed content is open, the live TPS is the request's calibrated thinking tokens over its thinking time so far (the settled thinking-rate formula), available from 1.5 s of thinking time, instead of the 5 s window that falls to zero in the silences between summary chunks.
- The burst cluster criterion searches its densest 100 ms window outside the backlog window that opens each output phase, still dividing by all arriving output tokens, so a normal stream that starts with a backlog is no longer a burst and no request becomes one that was not before. Backlog windows after stalls stay in the search, so a flush after a long silence is still caught.
- The settled generation rate of a request without an observed thinking phase counts its output by the live window's rules over the whole request (first delta of a phase, stalls and backlog windows excluded), scaled to the reported usage, so the backlog generated during TTFT no longer inflates the rate and the per-model average. Requests with a thinking phase keep their rate: their backlog was generated during the thinking time already in the denominator.
- README: the live TPS, generation rate, burst and limitation sections describe the backlog window, the thinking-phase rate and the remaining discrepancies.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `request-measurement`: "Live output TPS over a sliding window" (backlog window after every uncounted arrival; cumulative rate while a streamed thinking phase is open), "Settlement from provider usage" (counted output for requests without a thinking phase), "Burst detection" (the cluster criterion's window search leaves out the backlog window that opens an output phase).

## Impact

- `src/measurement.ts` (arrival floors, live rate, settlement), `src/burst.ts` (cluster input), `src/constants.ts` (`BACKLOG_WINDOW_MS`), their tests in `test/measurement.test.ts`, `test/burst.test.ts` and `test/pipeline.test.ts`, and `README.md`.
- Records keep schema version 2. For requests without a thinking phase, `generatedTokens` and `generationMs` now hold the counted figures (fractional tokens possible); records written before the change keep their old values and are averaged with the new ones, which only shifts a model's moving average toward the corrected value as new requests arrive.
- No new dependencies, events or configuration.
