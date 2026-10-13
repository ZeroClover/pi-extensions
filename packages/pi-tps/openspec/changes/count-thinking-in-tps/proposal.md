# Proposal

## Why

pi-tps reports generation speed as visible output tokens over the active output span, so a model's thinking phase is excluded from every TPS figure and the live readout shows `—` for as long as the model thinks. That penalises reasoning models that only stream a summary or nothing at all, and it is also wrong in the other direction: providers that stream a full chain of thought but report no reasoning breakdown (every OpenAI-compatible endpoint sets `usage.reasoning` to 0, so Ollama, llama.cpp and most proxies) have their thinking tokens counted as output over the output time alone, inflating the TPS and the calibration ratio. The live figure also starts high and decays, because the first chunk's tokens are divided by the time since that chunk arrived.

## What Changes

- **BREAKING** The TPS of a request, a run and the session becomes the *generation rate*: every output token the provider reports (thinking included, as `usage.output` already is) over the time the model spent generating: the thinking phases plus the active output span. Thinking enters the figure whenever a thinking phase was observed in the stream (a thinking block with its start and end events, with or without deltas). Without an observed thinking phase the figure is the visible-output rate as before; a reported reasoning count without an observed phase is subtracted from the output and its time is not guessed.
- Thinking time is measured from the provider's phase boundaries (`thinking_start` / `thinking_end`, falling back to the first thinking delta and the first following delta) as wall time; silence inside a thinking phase is generation of hidden or unsummarised reasoning, not a stall. Stall detection applies to the output phase only. Hidden reasoning (a thinking block without deltas, as the Responses API emits) is timed by its events.
- `usage.reasoning === 0` with a streamed thinking phase is treated as "no breakdown": thinking tokens are estimated and the output calibration compares the total, so the thinking tokens no longer inflate the visible output and the calibration ratio.
- TTFT ends at the start of the first thinking block when that block later streams non-empty thinking; otherwise at the first non-empty delta as before.
- The live TPS counts thinking and output tokens, starts during the thinking phase, attributes each delta's tokens to the interval since the previous delta and prorates the interval that straddles the window edge, excludes the first delta of a phase and output stalls from both numerator and denominator, and becomes available after 1.5 s of counted generation time. Thinking tokens get their own calibration ratio per model (`usage.reasoning` over the thinking estimate), so models that stream a summary converge on their real reasoning rate.
- Requests qualify for the run and session TPS by generation time (thinking plus output) of at least 1 s, so thinking-heavy tool calls contribute.
- **BREAKING** The run record schema moves to version 2 (generation time and rate, thinking phase kind); version-1 entries are ignored on reconstruction. The calibration file moves to version 2 (thinking ratio per model); older files are ignored and calibration starts over.
- Readout: the `TPS` field of the streaming, summary and session states shows the generation rate; `think` shows the phase's duration also for hidden reasoning; the README's field and measurement sections are rewritten accordingly.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

The capabilities below were introduced by the change `add-tps-readout`, which is implemented but not yet archived, so `openspec/specs/` does not hold them yet. This change deliberately contradicts several of its requirements (they explicitly exclude thinking from the TPS); the deltas are written against the requirement headers of `add-tps-readout` and this change MUST be archived after it so that the MODIFIED blocks apply.

- `request-measurement`: "Time to first token" (thinking start can end the wait), "Thinking and output are measured separately" (thinking is a wall-time phase from provider events, output keeps the active span), "Live output TPS over a sliding window" (becomes the live generation rate with prorated intervals and stall exclusion), "Stall detection" (output phase only), "Settlement from provider usage" (generation rate over generation time; `reasoning === 0` with streamed thinking is no breakdown), "Burst detection" (rate criterion uses the generation rate).
- `telemetry-history`: "Record schema is versioned" (version 2), "Run TPS" (generation rate over generation time), "Session aggregates" (same formula), "Run TTFT, sums and elapsed time" (thinking phase time summed).
- `token-estimation`: "Calibration ratio per provider and model" (the `reasoning === 0` case, and a thinking ratio), "Calibrated live counts" (thinking factor and marker), "Calibration persists across sessions" (file version 2).
- `tps-readout`: "Readout phases" (streaming during thinking, hidden thinking), "Summary only after the run settles" (TPS is the generation rate).

## Impact

- `src/measurement.ts` (phase boundaries from `*_start`/`*_end` events, thinking wall time, live window, settlement), `src/aggregate.ts` (qualification and rate), `src/telemetry.ts` (record version 2, new fields, parser), `src/calibration.ts` (thinking ratio, file version 2), `src/constants.ts` (thinking clamp), `src/format.ts` (hidden thinking, duration-only `think`), `src/index.ts` (forwarding phase events), their tests, `README.md`, and the root README table description.
- Event-bus consumers: `RequestRecord` and `LiveSnapshot` gain fields and `RunRecord.version` becomes 2; `outputTps` and `thinkingTps` stay for consumers that want the split.
- Session files: existing version-1 `pi-tps` entries stop contributing to the idle summary and session average. `~/.pi/agent/pi-tps-calibration/` is rewritten in version 2 on the first calibrating request.
- No new dependencies; no new Pi events (the `message_update` payload already carries `thinking_start`, `thinking_end`, `text_start` and `toolcall_start`).
