# Design

## Context

See proposal.md for motivation. Facts that shape the approach, verified in `node_modules/@earendil-works/pi-ai/dist` (1.1.0):

- `usage.output` always includes reasoning tokens (`types.d.ts`, `Usage.reasoning` doc). A generation rate over the whole request therefore needs no reasoning breakdown; only the visible/thinking *split* does.
- `usage.reasoning` is set per backend: Anthropic only when `output_tokens_details.thinking_tokens` is in the response (`anthropic-messages.js:642`), otherwise `undefined`; OpenAI Completions and Responses, and Google, always set it, as `reasoning_tokens || 0` / `thoughtsTokenCount || 0`. Ollama and llama.cpp never report `reasoning_tokens`; vLLM depends on the version. So `0` cannot be distinguished from "unreported" by the value alone, only by whether thinking was streamed.
- Every backend emits `thinking_start` and `thinking_end` around a thinking block. The Responses API emits them at `response.output_item.added/done` of a reasoning item even when no summary is requested (`openai-responses-shared.js:354, 590`), so hidden reasoning has measurable boundaries. Anthropic emits them for `thinking` and `redacted_thinking` blocks. OpenAI Completions emits `thinking_start` at the first `reasoning_content`/`reasoning` delta and `thinking_end` at the transition. `message_update` hands the full `AssistantMessageEvent` to extensions.
- Reasoning summaries (Responses, Gemini, Claude 4) arrive in chunks separated by seconds of silence; Anthropic bills the full thinking tokens behind a summary. The Responses adapter injects a `"\n\n"` thinking delta per summary part.
- The current measurement (`src/measurement.ts`) keeps one estimate and one active span per kind, infers phases from delta kinds, treats any gap of 500 ms or more as a stall, and keeps the live window on output deltas only. `settle()` derives visible output as `usage.output − thinkingTokens` with `thinkingTokens = usage.reasoning > 0 ? reasoning : undefined` when `reasoning` is defined.
- The change `add-tps-readout` is implemented but unarchived, and the working tree holds uncommitted calibration fixes (REVIEW.md, tasks 12.x). This change builds on that tree and does not touch the calibration concurrency protocol.

## Goals / Non-Goals

**Goals:**
- One definition of "generation time" used identically by the request record, the run and the session.
- Thinking time from provider boundaries, so summary-only and hidden reasoning are timed as the model spent it.
- A live rate that is unbiased at the start of a stream and consistent with the settled rate's exclusions.
- Keep every figure explainable: numerator, denominator, exclusion, marker.

**Non-Goals:**
- Guessing thinking time when the provider gives no phase (reasoning count without events): the record keeps the count, the rate stays output-only.
- Per-token timestamps or tokenizer-exact counts.
- Migrating version-1 records or version-1 calibration files.
- Changing the stall threshold, window length, burst criteria or EMA parameters beyond what the specs state.

## Decisions

### D1. Thinking is a wall-time phase, output is an active span

Thinking blocks are tracked as `{ startAt, endAt?, deltas }` from `thinking_start` / `thinking_end`; a `thinking_delta` without an open block opens one, and any non-thinking event (`text_start`, `toolcall_start`, output delta, `message_end`) closes an open block. `thinkingMs = Σ (endAt − startAt)`. No stall rule inside a block: silence while thinking is reasoning that is not streamed (summary models) or streamed later (chunked summaries), and counting it is what makes the summary-only case fair. The output side is unchanged (gaps < 500 ms between consecutive output deltas). The gap between `thinking_end` and the first output delta belongs to neither (it is the provider's block framing and is small).

Alternative considered: keep gap-based spans and merely not apply the stall rule to thinking deltas. Rejected: it cannot time hidden reasoning, and the time before the first summary chunk (often most of the phase) would still be lost.

Alternative considered: thinking time = first delta of any kind → first output delta. Rejected: breaks for interleaved thinking (several blocks) and for Anthropic's small framing gaps; the events are precise and available everywhere.

### D2. Generation time and rate

`generationMs = thinkingMs + outputMs`; `tps = usage.output / generationMs` when `generationMs ≥ MIN_SETTLED_SPAN_MS`. The record keeps `outputTps` (visible output over `outputMs`) and `thinkingTps` (thinking tokens over `thinkingMs`) as secondary figures for bus consumers; the readout, the aggregate and the colour thresholds use `tps`. Aggregates sum `outputTokens` over `generationMs` of qualifying records, which is the duration-weighted mean of the per-request rates, as before.

Why gate on an observed phase rather than on a reasoning count: the count is unreliable as a presence signal (see Context), whereas a phase is either in the stream or not. With a count but no phase (o-series behind a Chat Completions proxy, no `reasoning_content`), the model did think, but its time is only known as part of TTFT and cannot be separated from prefill; inventing it would make the figure less explainable than the visible-output rate. The user's rule "no thinking count → no thinking TPS" is preserved in the only case where it still matters: neither phase nor count → visible-output rate.

### D3. `reasoning === 0` with streamed thinking means "no breakdown"

`settle()` derives a breakdown only from a positive `usage.reasoning`. Otherwise, with streamed thinking, thinking tokens are the calibrated thinking estimate (marked estimated) and the output calibration sample compares `usage.output` with the total estimate, exactly the existing no-breakdown branch. This removes the inflated visible output and the inflated output ratio for Ollama, llama.cpp and similar backends. A model that really did not think reports `reasoning 0` *and* streams no thinking, so nothing changes for it.

Trade-off: Anthropic summarised thinking without the `thinking_tokens` field keeps calibrating the output ratio against summary + output (total branch), which overstates the ratio for that model. Accepted: newer Anthropic responses carry the field, the summary case is shrinking, and skipping calibration entirely would leave such models uncalibrated forever.

### D4. Live window: interval attribution

The live rate is computed from the delta timeline (already recorded for burst detection) as follows. For delta *i* with arrival `at[i]` and arriving tokens `tok[i]` (output or thinking, each multiplied by its ratio), its interval is `(at[i−1], at[i]]` when the previous delta belongs to the same phase and the gap is counted (always for thinking, < 500 ms for output); otherwise the delta has no interval and is skipped. With the window `W = (now − 5 s, now]`: `numerator = Σ tok[i] · |interval_i ∩ W| / |interval_i|`, `denominator = Σ |interval_i ∩ W| + trailing`, where `trailing = now − at[last]` when the open phase is thinking, or output and under 500 ms. Available when `denominator ≥ 1.5 s`.

This removes the early bias (the first chunk's tokens were generated during TTFT, not during the window) and the edge bias (a chunk straddling the window edge counted in full), makes the live figure's exclusions match the settled ones (stalls out), and costs O(deltas in window) per tick as before. The settled rate still counts the first chunk's tokens because it rests on `usage.output`; the discrepancy is one chunk per phase and is documented.

Alternative considered: keep the current cumulative-count window and only drop the first delta. Rejected: still biased at the window edge, and inconsistent with stall exclusion.

Alternative considered: an EMA. Rejected: smoothing hides what the user asked to see precisely.

Hidden thinking blocks contribute no tokens and no time to the live window; while one is open the live TPS is unavailable and the readout shows the block's running duration.

### D5. Thinking calibration ratio

`CalibrationEntry` gains `thinking?: { ratio, samples, updatedAt }` (or an equivalent second entry keyed by kind); the store's `ratio(key)` returns both factors. Sample: `usage.reasoning / rawThinking`, only for streamed thinking with a positive reasoning count and a raw estimate above `CALIBRATION_MIN_ESTIMATE`; clamp `[0.25, 100]` (`CALIBRATION_MAX_THINKING_RATIO`), same EMA. The wide upper clamp is needed because a summary is one to two orders of magnitude shorter than the reasoning it summarises. The file format version becomes 2; version-1 files are ignored (no migration, per repository principles), so calibration restarts once.

Alternative considered: one ratio for both kinds. Rejected: the output ratio is near 1 for every model, the thinking ratio is near 1 only for full chain-of-thought models; mixing them would corrupt both.

### D6. Record schema version 2

`RequestRecord` changes: `thinking: "none" | "hidden" | "streamed"` replaces `thinkingObserved`; `thinkingMs` is the phase wall time; new `generationMs` and `tps`; `outputTps` / `thinkingTps` kept. `RunRecord.version` becomes 2 and `parseRunRecord` accepts only 2. Reconstruction of a session with version-1 entries starts empty (the user sees the empty state until the next run); no compatibility reader, per repository principles. `LiveSnapshot` gains `thinking` (phase kind), `thinkingCalibrated` and `tpsCalibrated` so the renderer can mark the figures per D5.

### D7. TTFT

TTFT snaps to the open block's `thinking_start` when the first non-empty delta is a thinking delta of that block; the `ttftMs` of a request is written then. The live snapshot keeps counting up until a delta arrives, so the user never sees a frozen TTFT before the model has visibly started. `ttftTextMs` and `headersMs` are unchanged.

### D8. Burst criterion input

The few-batches criterion compares the batch count with the streamed tokens: visible output plus thinking tokens when streamed. Hidden reasoning tokens arrive in no batch, so a 900-token hidden phase followed by a 40-token answer must not read as a buffered 940-token response. The rate criterion uses `tps` (generation rate).

### D9. Wiring

`contentDelta` in `src/measurement.ts` becomes `phaseEvent`, mapping `thinking_start`, `thinking_end`, `text_start`, `toolcall_start` and the three delta kinds to a normalised input; `src/index.ts` forwards it unchanged. No new Pi events are consumed.

## Risks / Trade-offs

- [A thinking phase with a real network stall is counted as generation] → Accepted; indistinguishable from unsummarised reasoning. The output phase keeps stall detection, so a stalled proxy still shows up in `stall` once output starts.
- [Thinking-ratio samples from summaries are noisy: summary length does not scale linearly with reasoning] → EMA with α 0.3 and the `~` marker until the first sample; the settled figures never use the ratio (they use `usage`).
- [Version bump drops the session average of existing sessions and resets calibration] → One-time; stated in README. No migration code by repository rule.
- [Thresholds tuned for output speed now colour a rate that includes thinking] → Thinking rates of full-CoT models equal their output rates; summary models' rates become their true reasoning rate, which is what the thresholds should judge. README notes that per-model overrides may need adjusting.
- [Live and settled rates differ by the first chunk of each phase] → Documented; the settled figure is the authoritative one.
- [`"\n\n"` separator deltas from the Responses adapter count as arrivals] → They mark real activity and estimate to at most one token each; ignored.
- [Archive order] → This change's deltas are MODIFIED against `add-tps-readout`; `openspec validate` reports that the targets do not exist yet. Archive `add-tps-readout` first.
