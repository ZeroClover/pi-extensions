# Design

## Context

See proposal.md for motivation. Constraints that shape the approach:

- Pi 1.1.0 delivers streaming through `message_update` whose `assistantMessageEvent` is a typed `AssistantMessageEvent` (`text_delta`, `thinking_delta`, `toolcall_delta`, `*_start`, `*_end`, `done`, `error`). This is the only per-token signal; providers report `usage` once, at the end.
- `before_provider_request` fires when the payload is final and about to be sent; `after_provider_response` fires with the HTTP status once headers arrive. `turn_start` fires earlier (before context handlers), so it is a poor TTFT origin.
- `AssistantMessage.timestamp` (request start, wall clock) and `durationMs` (monotonic, set at stream end) exist on every finished message; `usage.reasoning` is a subset of `usage.output` and is present only for some providers; `usage.cost` is all zeros when the model has no price.
- `ctx.ui.setStatus` calls `requestRender()` on every invocation (coalesced per tick); each render diffs the whole screen. The footer joins all extension statuses on one line, sorted by key.
- `ctx.ui.theme.fg(token, text)` colours with theme tokens; `theme.style(text, { fg: Color })` accepts a concrete `Color`, and `parseColor()` from `@earendil-works/pi-tui` turns `#rrggbb` into one.
- The repository forbids `any`, casts, `console.*`, timers in the factory, and requires logic in Pi-free modules with Vitest tests (docs/conventions.md).
- Existing implementations studied: monotykamary/pi-tps (turn-end banner, stall/burst gating, cost, plain-word display `TPS 42.5 tok/s · TTFT 1.2s · …`), shreyashp77/pi-tps (live footer, EMA, colours, thinking count), EnderLiquid/oh-my-tps (phase state machine, `before_provider_request` origin, 5 s window, tokenx, event-bus renderer split, two-symbol display `τ0.8 Δ48.6`).
- One user prompt usually becomes several provider requests (tool calls, retries, continuations). `agent_end` fires per agent loop; `agent_settled` fires once Pi will not continue automatically and reports whether the run was aborted.

## Goals / Non-Goals

**Goals:**
- One Pi-free measurement core driven by normalised inputs and an injectable clock, fully unit-testable with synthetic delta timelines.
- A render path whose cost is bounded by the ticker interval, not by the delta rate.
- Figures that are explainable: every number has a stated numerator, denominator and exclusion rule; unreliable numbers are marked, never silently inflated.

**Non-Goals:**
- Exact tokenisation for any model family; a calibrated heuristic is the target.
- Measuring sub-agent, compaction, cache-warming or classifier requests.
- A dedicated widget, custom footer, or multi-line display.
- Per-project configuration.
- Export commands (the session file already holds the records; a later change can add one).

## Decisions

### D1. Module layout

```
packages/pi-tps/
├── package.json            pi manifest; dependencies: tokenx; peers: pi-coding-agent, pi-ai, pi-tui
├── README.md
├── src/
│   ├── index.ts            wiring only: events → core, core → renderer/persistence/bus
│   ├── constants.ts        every threshold (stall 500 ms, window 5 s, warm-up 1.5 s, burst limits, EMA α, clamp)
│   ├── clock.ts            Clock interface { now(): number } + performance.now default
│   ├── measurement.ts      request state machine; pure functions over normalised deltas
│   ├── run.ts              run tracker: start/settle, elapsed time, request records of the active run
│   ├── burst.ts            burst classifier over the delta timeline
│   ├── estimator.ts        tokenx wrapper + incremental per-delta estimate
│   ├── calibration.ts      ratio store: load/update/save, EMA, clamp
│   ├── aggregate.ts        run and session aggregates from request records; reconstruction from entries
│   ├── telemetry.ts        request and run record types (versioned), snapshot type, event channel names
│   ├── config.ts           schema, defaults, loader with warnings, threshold resolution and glob matching
│   ├── format.ts           number/duration/token formatting, field layout per phase and label style
│   ├── render.ts           colour application via Theme; produces the setStatus string
│   └── ticker.ts           throttled interval driver (start/stop, frame index)
└── test/                   one file per module above
```

Rationale: mirrors oh-my-tps's "core is Pi-free, renderer is a subscriber" split, which the repository conventions also demand (thin `index.ts`, testable modules). Alternative (single file like monotykamary) rejected: untestable under this repo's rules.

### D2. Request lifecycle and state machine

States: `idle → waiting → streaming → settled | aborted | errored`.

| Transition | Trigger | Notes |
|---|---|---|
| idle → waiting | `before_provider_request` while `turnActive` | `turnActive` set by `turn_start`, cleared by `turn_end`. Filters cache warming, compaction and branch summaries, which run outside a turn. A second `before_provider_request` in the same turn (retry) resets to waiting from the new timestamp. |
| waiting → streaming | first `message_update` with non-empty `text_delta` / `thinking_delta` / `toolcall_delta` | TTFT locked. `after_provider_response` timestamp recorded as time-to-headers (telemetry only). |
| streaming → settled | `message_end` with assistant role and `stopReason` in `stop` / `length` / `toolUse` | Settlement computed from `usage`. |
| waiting/streaming → aborted | `message_end` with `stopReason: "aborted"` | Partial record, abort flag. |
| waiting/streaming → errored | `message_end` with `stopReason` `error` or `deferred` | Live cleared, previous settled kept, no record. |
| any → idle | `agent_end`, `session_shutdown` | Request in flight dropped. |

`message_start` is not used for timing (it fires at stream creation, before tokens). It confirms that an assistant stream belongs to the active turn and carries the identity of the model that actually serves the request (`provider`, `model`), which replaces the selected model's identity for the calibration ratio and the thresholds. The selected model (`ctx.model`) can be a virtual model that routes to a different physical model; only the message names the physical one.

Alternative considered: `turn_start` as the TTFT origin (monotykamary). Rejected: it precedes `context` handlers and payload transforms, inflating TTFT by extension work.

### D2a. Runs

A run groups the requests of one user prompt and is the unit of the summary. `run.ts` holds `active`, the monotonic start time, the wall-clock start and the request records settled so far.

| Transition | Trigger | Notes |
|---|---|---|
| idle → active | `agent_start` while no run is active | Start time recorded; ticker started. Later `agent_start`s (retries, continuations) join the active run. |
| active: record added | request settled or aborted at `message_end` | Record appended to the run; emitted on `pi-tps:telemetry`; calibration updated. No summary is rendered. |
| active → idle | `agent_settled` | Elapsed time fixed, `aborted` taken from the event. A run with records becomes the last run, is persisted and emitted on `pi-tps:run`; a run without records is discarded. Ticker stopped; idle readout rendered. |
| any → idle | `session_shutdown` | Active run discarded. |

Alternative considered: summarising after each request or each `agent_end`. Rejected after live use: a prompt with tool calls produced a new "average" after every request, which flickered between unrelated figures and never described the whole answer.

### D3. Delta timeline and phases

Each accepted delta is appended as `{ at, kind: "thinking" | "output", rawTokens }` with a running prefix sum per kind. From this single array the core derives:

- TTFT (first entry), time to first visible text (first `output` entry).
- Active spans per kind: sum of gaps between consecutive entries of that kind, excluding gaps ≥ 500 ms (stalls). The gap between the last thinking entry and the first output entry is attributed to neither.
- Live output TPS: prefix-sum difference over the entries with `at ≥ now − 5000`, divided by `min(5000, now − firstOutputAt)`; unavailable before 1.5 s. Computed on the ticker, not per delta.
- Burst features: arrival-batch count (deltas less than 1 ms apart form one batch), largest 100 ms cluster share.

`toolcall_delta` counts as output: tool arguments are generated tokens. The estimate uses the raw JSON delta.

Alternative (oh-my-tps): keep a queue of raw strings and re-tokenise the joined window on every delta. Rejected for O(n·window) cost at high delta rates.

### D4. Token estimation and calibration

- Incremental `tokenx` estimate per stream: the text after the last separator-to-word boundary (tokenx's own segment separators: whitespace and ASCII punctuation) is kept open; each delta commits the complete segments before that boundary and re-estimates only the open tail. An open tail longer than 512 characters (digit runs, CJK prose without ASCII separators) commits 256 characters at a time, which costs at most one token of rounding per commit. The total therefore tracks the whole-text estimate regardless of delta size, and each delta costs O(delta + 512).
- Calibration key: `${provider}/${responseModel ?? model}`. Ratio = EMA with α = 0.3 over `reported / rawEstimate`, clamped to [0.25, 4], where the sample is `(usage.output − usage.reasoning) / rawOutput` when the provider reports a reasoning breakdown (streamed thinking is often a summary or hidden, so its estimate does not match the reasoning tokens) and `usage.output / (rawThinking + rawOutput)` otherwise; first sample sets the ratio directly. Updated only for settled, non-burst, non-aborted requests with `usage.output > 0` and raw estimate > 50 tokens (tiny responses are noisy).
- Thinking share at settlement: `usage.reasoning` when defined, else `rawThinking × ratio`, capped at `usage.output`.
- Store: `<agent-dir>/pi-tps-calibration.json` as `{ version: 1, models: { key: { ratio, samples, updatedAt } } }`. Written after each update (tiny file, once per request) inside a cross-process lock (`<file>.lock` created exclusively, retried for up to 200 ms, taken over when older than 2 s): the file is re-read and merged, then written to a temporary file and renamed, so concurrent Pi sessions neither lose updates nor read half-written files. Keys whose update could not be written stay authoritative in memory and are not overwritten by the disk copy on later merges. Load errors warn once.

Alternative: exact BPE (`gpt-tokenizer`). Rejected: MB-scale load, correct only for OpenAI encodings, and still needs calibration for Anthropic/Gemini.

### D5. Settlement formulas

Let `O = usage.output`, `R = thinking tokens` (D4), `So` = active output span, `St` = active thinking span, `T` = request start → message_end.

| Figure | Formula | Condition |
|---|---|---|
| Output TPS | `(O − R) / So` | not burst, `So ≥ 1 s` |
| Thinking TPS | `R / St` | thinking present, `St ≥ 1 s` |
| Throughput (burst) | `O / T` | burst |
| Fallback | calibrated estimate in place of `O` | `usage.output` missing or 0 |

Cross-check: `AssistantMessage.durationMs` is compared with the core's own `T`; a difference above 250 ms is recorded in the telemetry as `clockSkewMs` for debugging but does not change figures.

### D6. Burst classification

Evaluated once at settlement over the timeline (see spec `request-measurement`, "Burst detection"). Thresholds live in `constants.ts`:

```
BURST_BATCH_GAP_MS = 1
BURST_MIN_BATCHES = 5
BURST_MIN_TOKENS = 50
BURST_CLUSTER_WINDOW_MS = 100
BURST_CLUSTER_SHARE = 0.5
BURST_CLUSTER_MIN_SPAN_MS = 1000
MAX_PLAUSIBLE_TPS = 10000
```

Deltas are grouped into arrival batches before counting. Pi parses every SSE event of one network read in the same tick, so a fast provider shows many sub-millisecond gaps while streaming genuinely; the originally planned "median inter-delta gap below 1 ms" rule marked such streams (DeepSeek, GLM) as bursts in live tests and was replaced by "fewer than 5 batches", which still catches a buffered response flushed in a few reads. The rule applies only from 50 output tokens: live runs showed one-sentence replies arriving in 3 reads, which are too short to measure, not buffered, and labelling them burst replaced the run's TPS with a meaningless throughput.

The 100 ms cluster rule is the key addition over monotykamary: it catches a proxy that streams normally, buffers for a while, then flushes a large tail (the stall-then-burst pattern), which neither the delta count nor the median gap sees.

### D7. Rendering and animation

- `ticker.ts` owns one `setInterval`; started when a run starts, stopped at `agent_settled` and `session_shutdown`. Each tick: advance frame, ask the core for a snapshot (live request, else run progress), format, `setStatus`. Delta handlers only mutate core state. The UI of the handler that started the run is held for the ticks and released when the ticker stops.
- With `animation.enabled: false`: static indicator; the tick still runs but calls `setStatus` only when the formatted string changed.
- Idle states render once, synchronously, from the event that caused them.
- Colour: thresholds resolved once per request (on waiting) for the active model, and for a run or session summary from the model of its last contributing request; the TPS token is coloured with `theme.fg(token, text)` for tokens or `theme.style(text, { fg: parseColor(hex) })` for hex. Every other field uses `baseColor` (default `dim`). `theme` is read from `ctx.ui.theme` at render time, never cached, so theme switches apply at the next tick.
- Width: the footer truncates; the format keeps the most important fields first (indicator, TPS, TTFT, elapsed, tokens, thinking, stalls, count, cost) so truncation drops the tail.
- Label styles: `format.ts` lays out a phase as a list of fields, each with a text label and a symbol; `labels` selects which is printed and the separator (` · ` for text, a space for symbols). One layout, two vocabularies, so the styles cannot drift apart.

Layout (exact symbol set in spec `tps-readout`):

```
            text                                                                        symbols
waiting     ⠋ TTFT 1.2s                                                                  ⠋ ⇥1.2s
streaming   ⠙ TPS 48.6 tok/s · TTFT 1.2s · out 1.2K · think 1.9K 4.0s                    ⠙ »48.6/s ⇥1.2s ↓1.2K ✻1.9K 4.0s
working     ⠹ run 12.3s · req 2 · out 1.6K                                               ⠹ 12.3s ×2 ↓1.6K
done        TPS 110.5 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%) · out 1.4K ·       ✓ »110.5/s ⇥0.7s 18.4s ↑6.2K ↻92% ↓1.4K ✻94 4.1s ‖1.2s×1 ×3 $0.0018
            think 94 4.1s · stall 1.2s×1 · req 3 · $0.0018
burst only  burst 225.0 tok/s · TTFT 4.0s · 4.0s · in 3.1K · out 900 · req 1               ✓ ↯225.0/s ⇥4.0s 4.0s ↑3.1K ↓900 ×1
aborted     aborted · TPS 47.0 tok/s · TTFT 0.6s · 5.0s · out 64 · req 1                 ✗ »47.0/s ⇥0.6s 5.0s ↓64 ×1
session     session · TPS 110.0 tok/s · TTFT 0.6s · in 40K · out 6.2K · runs 3 · $0.050   Σ »110.0/s ⇥0.6s ↑40K ↓6.2K ×3 $0.050
empty       TPS — · TTFT —                                                               · »— ⇥—
```

Symbols are single-cell and non-emoji (emoji such as ⚡ or 💭 render two cells wide in most terminals and shift the footer). `↑`/`↓` follow Pi's own footer; `✻` is the thinking mark familiar from other coding agents; `‖` reads as a pause. Text labels follow monotykamary/pi-tps so the readout explains itself to first-time users; the symbol style is opt-in for users who want the compact form.

### D8. Configuration

- Loaded in `session_start` (the factory has no `ctx` and must not do I/O that could warn). Parsed with hand-written guards (no TypeBox validation of user JSON: the file is small and warnings must name fields precisely).
- Resolution order per spec `tps-configuration`. Glob support is `*` only, compiled to a `RegExp` with escaped literals; specificity = number of literal characters. No glob library.
- Colour validation: theme tokens checked against the `ThemeColor` union materialised as a `Set<string>` in `config.ts`; hex checked by regex. Hex is parsed with `parseColor` at render time.

### D9. Persistence and reconstruction

- `pi.appendEntry("pi-tps", run)` at `agent_settled` when `persist` is true (default) and the run has at least one record. The run record (`version: 1`) holds `startedAt`, `elapsedMs`, `aborted` and `requests` (the request records, about 400–600 bytes each). Entries never enter model context.
- One entry per run keeps reconstruction trivial (the last entry is the last run) and makes the persisted unit equal the displayed unit. A run cut short by quitting Pi is lost; acceptable for a readout.
- Format is deliberately independent of monotykamary/pi-tps (`customType: "tps"`): its per-turn schema lacks the thinking split, burst and abort flags, and following a third-party format would tie this package to its changes. Foreign entries are ignored on reconstruction.
- On `session_start` and `session_tree`: walk `ctx.sessionManager.getBranch()`, keep `custom` entries with `customType === "pi-tps"` and `version === 1`, rebuild the run list and aggregates through `aggregate.ts`. Entries are validated structurally before use (unknown shapes skipped).
- Run and session figures are computed from request records with one function (token-weighted TPS over requests with at least 1 s of active output, mean TTFT over non-aborted requests, sums), never incrementally mutated, so branch switches are a recompute and the run and session figures cannot disagree in method. The 1 s floor came from live runs: tool-call requests stream for 0.1–0.2 s while `usage.output` also counts unstreamed tool-call framing, which put them at 400–600 tok/s against 146 tok/s for the same model's text and lifted a four-request run to 222 tok/s.

### D10. Event bus

Channels and payload types live in `telemetry.ts`; `pi-tps:status` (snapshot or `null`), `pi-tps:telemetry` (request record, as each request settles), `pi-tps:run` (run record, at `agent_settled`), `pi-tps:request` (re-emit). The built-in renderer is wired directly in `index.ts` rather than as a bus subscriber, to avoid self-dispatch; the bus is for other extensions.

### D11. Commands

`/tps` with argument parsing in `index.ts`: no argument → toggle visibility; `mode` → toggle summary mode; `mode last|session` → set. Argument completions offered for `mode`, `last`, `session`. Visibility and mode are in-memory for the session; `summaryMode` in the config sets the initial value.

## Risks / Trade-offs

- [Providers that emit encrypted or summarised thinking without deltas] → thinking span is invisible; TTFT is measured to the first observable delta and the telemetry marks `thinkingObserved: false`. Documented limitation.
- [Thinking estimate used in the output-TPS numerator when `usage.reasoning` is absent] → the numerator carries estimation error; the readout marks the TPS as estimated-thinking (same uncalibrated marker). Calibration reduces it over time.
- [`before_provider_request` may fire for requests that are not the turn's main stream while a turn is active (e.g. an extension's own model call inside a tool)] → the core accepts only streams whose `message_start` is an assistant message and ignores a second concurrent request; the first `message_end` closes the measurement. Residual mismatch is logged as `clockSkewMs` via the `durationMs` cross-check.
- [Footer width overflow with many fields] → field order by importance; truncation by Pi is accepted; thinking group is last.
- [Calibration drifts when the same model is served through different providers with different tokenisers] → key includes provider.
- [Per-request file write of the calibration store] → one small synchronous write per request under a lock held for well under a millisecond; acceptable. Failure warns once. When the lock cannot be taken within 200 ms the update stays in memory and is written with the next one.
- [tokenx estimation cost at very high delta rates] → per-delta estimation of short strings is sub-millisecond; render is throttled; if profiling shows cost, batch estimation into the ticker.
- [Session files grow by one entry per run of ~0.5 KB per request] → under 2 % of a typical session file; `persist: false` disables persistence at the cost of empty history after reload.
- [Symbol style needs fonts with arrows, dingbats and box symbols] → all symbols are in the Unicode BMP and in common monospace fonts; the text style is the default.

## Open Questions

None.
