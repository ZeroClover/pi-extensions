# pi-tps

Generation-speed readout for Pi's footer. A raw tokens-per-second figure means little on its own, so while a request streams, pi-tps displays its live generation speed (TPS, thinking included) and time to first token (TTFT) beside the serving model's smoothed averages, coloured by how the request compares with them. Between requests it shows the run's progress, and when idle it shows the current model's averages and session totals.

- Measures TTFT, thinking and visible output tokens, generation speed (TPS), stalls, and burst delivery (responses buffered and flushed at once by a proxy).
- Estimates streamed tokens live with [tokenx](https://github.com/johannschopplich/tokenx) and calibrates per-model ratios against provider-reported usage.
- Stores one record per run in the session file so averages and totals survive resume, `/reload`, and `/tree`.
- Publishes live status and settled telemetry on Pi's event bus for other extensions.

## Install

Published to npm as `@zeroclover/pi-tps` and tagged `@zeroclover/pi-tps@<version>` with release notes from `CHANGELOG.md`.

```bash
pi install npm:@zeroclover/pi-tps             # install a published version for the user
pi -e ./packages/pi-tps                       # try a repository checkout for one session
pi install /absolute/path/to/packages/pi-tps  # install a repository checkout for the user
```

## Provides

| Kind | Name | Description |
|---|---|---|
| command | `/tps` | Show or hide the readout (takes no arguments). Measurement, persistence, and event broadcasts continue while hidden. |
| status | `pi-tps` | Footer readout written with `ctx.ui.setStatus` (interactive mode only). |
| session entry | `customType: "pi-tps"` | One record per run; never sent to the model. |
| events | `pi-tps:status`, `pi-tps:telemetry`, `pi-tps:run`, `pi-tps:request` | Event-bus channels for other extensions (see [Event bus](#event-bus)). |

Visibility resets to `enabled` from the configuration on `/reload` or session switch.

## Reading the readout

The readout occupies one line in Pi's footer. It tracks a **run**: everything Pi does for one prompt from submission until Pi stops on its own, including all model requests, tool calls, automatic retries, and queued follow-ups. While a request is in flight, the line compares it against the model's usual figures; when no run is active, it shows those averages alongside totals for the current branch.

### What you see

A spinner (`⠋⠙⠹…`) at the start of the line means a run is active; `✓` or `✗` means the last run has finished. With the current model averaging 52.3 tok/s and 1.1 s TTFT, the line goes through states like these:

<!-- example-lines: test/format.test.ts checks that pi-tps prints each of these lines exactly -->
```text
⠋ - TPS | TTFT 1.4s
⠹ - (x̄52.3) TPS | TTFT 2.0s (x̄1.1s) | 2➤
⠼ 68.3 (x̄52.3) TPS | TTFT 0.6s (x̄1.1s) | ↓1.2K | ⠿1.9K 4.0s | 2➤
⠧ - (x̄52.3) TPS | TTFT 4.2s (x̄1.1s) | ⠿4.0s
⠇ x̄52.4 TPS | TTFT x̄1.0s | run 12.3s | 1➤ | ↓1.6K
✓ x̄52.4 TPS | TTFT x̄1.0s | 3 runs in 4m 12s | 14➤ | ↑40K ◎88% | ↓6.2K | ⠿2.1K | $0.050
✗ x̄52.1 TPS | TTFT x̄1.0s | 4 runs in 4m 17s | 15➤ | ↑46K ◎89% | ↓6.3K | ⠿2.1K | $0.054
✓ x̄↯225.0 TPS | TTFT x̄4.0s | 2 runs in 9.1s | 2➤ | ↑6.2K | ↓1.8K | $0.0040
- TPS | TTFT -
```

1. **Waiting, first request of a model:** Request sent, `TTFT` counting up; no average on this branch yet.
2. **Waiting:** Second request of the run; live TPS is `-` until tokens arrive, with averages in parentheses.
3. **Streaming:** Thinking or answering; live figures for this request update about 10 times per second.
4. **Streaming, hidden thinking:** The model thinks without streaming its thoughts (for example OpenAI reasoning models); only thinking time is shown, and `TTFT` keeps counting until content arrives.
5. **Working:** Between requests (usually while a tool runs); shows the current model's averages (already updated with the just-finished request), run elapsed time, request count, and output so far.
6. **Idle:** After three runs; shows the current model's averages and branch totals across all runs.
7. **Idle after an aborted run:** Stopped with Escape; branch totals still include the aborted run.
8. **Idle with a burst-only model:** Every response arrived in a single flush rather than streaming (typical of a buffering proxy), so burst throughput (`↯`) is shown instead of generation speed.
9. **No data:** Nothing has been measured on this branch yet.

### Fields

Fields are separated by ` | ` (see `separator` in [Configuration](#configuration)), appear only when they have a value, and are ordered by priority so narrow terminals truncate from the right. See [Measurement](#measurement) for how each metric is calculated.

| Field | Shown in | Meaning |
|---|---|---|
| `68.3 (x̄52.3) TPS` | Waiting, streaming | Live generation speed (thinking included) of the request in flight, followed by the serving model's average TPS in parentheses when available. Shows `-` before enough data arrives or during hidden thinking. |
| `x̄52.4 TPS` | Working, idle | Smoothed average TPS of the current model (`- TPS` when none). |
| `x̄↯225.0 TPS`, `(x̄↯225.0)` | All | Average burst throughput (output tokens divided by total request time, wait included), shown in place of average TPS when the model has only burst requests. |
| `TTFT 0.6s (x̄1.1s)` | Waiting, streaming | Time to first token of the request in flight, followed by the serving model's average TTFT. Counts up while waiting (and during hidden thinking) and freezes when the first piece arrives. |
| `TTFT x̄1.0s` | Working, idle | Smoothed average TTFT of the current model (`TTFT -` when none). |
| `↓1.2K` | Streaming, working, idle | Visible output tokens (answer text and tool-call arguments, excluding thinking): live estimate for the current request while streaming, run total while working, and session total when idle. |
| `⠿1.9K 4.0s` | Streaming, idle | Reasoning tokens and thinking duration for the current request (time omitted under 0.05 s; only time `⠿4.0s` shown during hidden thinking). When idle, shows session thinking tokens alone (`⠿2.1K`) if any were streamed or reported. |
| `2➤` | Waiting, streaming, working, idle | Request index in the run while in flight (shown from the 2nd on), run request count while working, and session request count when idle. Errored requests are excluded. |
| `run 12.3s` | Working | Elapsed time since the run started, including tool execution. |
| `3 runs in 4m 12s` | Idle | Completed runs (prompts) on the branch and their summed wall-clock time (`1 run in 18.4s` for one). |
| `↑40K ◎88%` | Idle | Total input tokens sent across the session (including cached tokens, since each request re-sends the conversation), with `◎` showing the share read from the prompt cache when non-zero. Omitted when no input was reported. |
| `$0.050` | Idle | Total session cost in US dollars, shown when the model has pricing in Pi. |

### Markers

| Marker | Meaning |
|---|---|
| `⠋⠙⠹…` | A run is active. With animation disabled, the first frame is shown without rotating. |
| `✓` | The last run finished normally. |
| `✗` | You stopped the last run with Escape. |
| `x̄` | The figure after it is an average (`x` with combining macron U+0304). |
| `↯` | The average after it is burst throughput rather than generation speed. |
| `-` | Not known yet or not measurable (for example requests too short to rate). |

### Averages

Averages are tracked per provider and model over settled requests on the current branch in chronological order, so they are restored on resume, `/reload`, and `/tree`. Each average uses the plain mean of the first 10 samples and then blends new samples with weight 0.1 so a single slow or fast request barely shifts it (see [Measurement](#measurement)). Parenthesised averages never include the request currently in flight.

While a request is in flight, the readout shows the averages of the **serving model**: the selected model until the provider reports the physical model behind a virtual one. When working or idle, it shows the averages of the **current model**: the model you selected, or, when the branch's last request used that selection, the physical model that served it. Switching models updates the idle readout immediately.

### Colours

The live TPS (number and `TPS` label) and live TTFT (`TTFT` label and time) are coloured according to `tps.mode` and `ttft.mode` (configurable globally or per model via `overrides`):

- **`relative`** (default): compares the live figure against the serving model's average. TPS is `live / average` as a percentage; TTFT is `average / live` as a percentage so a faster-than-usual first token scores above 100%. By default 75 % or more uses the theme's `success` colour, 40 % or more `warning`, anything lower `error` (green, yellow, and red in most themes). A slow model running at its usual speed is therefore green.
- **`absolute`**: colours the raw value. By default, TPS is `error` below 30 tok/s, `warning` from 30, and `success` from 80; TTFT is `success` below 3 s, `warning` from 3 s, and `error` from 6 s.

Relative mode falls back to absolute thresholds while a model has no average for that metric (its first request), and for TPS when its only average is burst throughput. A live `-` and a live TTFT during open hidden thinking use `baseColor`. When no run is active, threshold colours are not used: `✓` uses `success`, `✗` uses `error`, `↯` uses `burstColor`, separators use `separatorColor`, and everything else (averages included) uses `baseColor`.

### Number formats

Token counts below 1000 are exact; larger counts use `K`, `M`, and `B` with one decimal, dropping `.0` (`1.2K`, `40K`). Durations show one decimal below a minute (`18.4s`), then the two largest units (`1m 30s`, `2h 15m`, `3d 12h`). Speeds always show one decimal. Costs show four decimals below $0.01, three below $1, and two from $1 up.

## Configuration

Read from `~/.pi/agent/pi-tps.json` (Pi's agent directory, `getAgentDir()`) at session start; run `/reload` after editing. A missing file uses the defaults. Invalid JSON or an invalid field produces one warning per problem and falls back to the default for that field only; a bad configuration never disables the readout.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Initial visibility of the readout |
| `persist` | boolean | `true` | Append a `pi-tps` session entry per run. When `false`, runs live only in memory, start empty each session, and do not follow `/tree` |
| `calibration` | boolean | `true` | Learn per-model token ratios (see [Estimation and calibration](#estimation-and-calibration)). When `false`, live counts use raw tokenx estimates and the calibration directory is neither read nor written |
| `separator` | non-empty string without control characters | `" \| "` | String drawn between fields |
| `baseColor` | colour | `"dim"` | Colour of the spinner, averages, non-live labels, and other fields |
| `separatorColor` | colour | `"borderMuted"` | Colour of the field separator |
| `burstColor` | colour | `"mdLink"` | Colour of `↯` before a burst throughput |
| `animation.enabled` | boolean | `true` | Rotate the spinner; when `false`, the readout redraws only when a value changes |
| `animation.intervalMs` | number `50`–`1000` | `100` | Refresh interval in ms while a run is active |
| `animation.frames` | non-empty strings without control characters | braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | Spinner frames |
| `tps.mode` | `"relative"` \| `"absolute"` | `"relative"` | How live TPS is coloured (see [Colours](#colours)) |
| `tps.relative` | threshold list (% of model's average TPS) | `0→error, 40→warning, 75→success` | Bands for live TPS in relative mode |
| `tps.absolute` | threshold list (tokens/s) | `0→error, 30→warning, 80→success` | Bands for live TPS in absolute mode, or when no TPS average exists |
| `ttft.mode` | `"relative"` \| `"absolute"` | `"relative"` | How live TTFT is coloured |
| `ttft.relative` | threshold list (average TTFT as % of live TTFT) | `0→error, 40→warning, 75→success` | Bands for live TTFT in relative mode |
| `ttft.absolute` | threshold list (seconds) | `0→success, 3→warning, 6→error` | Bands for live TTFT in absolute mode, or when no TTFT average exists |
| `overrides` | object of `{ "tps"?, "ttft"? }` | `{}` | Per-provider/model `tps` and `ttft` overrides |

- **Threshold list:** an array of `{ "min": number, "color": colour }` in any order. A value takes the colour of the highest `min` not exceeding it (later entries win ties); values below the lowest `min`, or an empty list, use `baseColor`.
- **Colour:** any foreground token of the active Pi theme (`success`, `warning`, `error`, `accent`, `dim`, `muted`, `text`, …) or a hex colour (`#rgb` / `#rrggbb`, rendered in truecolor or mapped to the nearest palette colour by Pi).
- **Overrides:** map a case-insensitive pattern to optional `tps` and `ttft` objects (`mode`, `relative`, `absolute`), matched against the serving model. Only the first `/` separates provider and model, so `openrouter/anthropic/claude-*` targets OpenRouter's `anthropic/claude-*` models. When multiple patterns match, only the single most specific override applies, in this order:
  1. `provider/model` (exact provider and model)
  2. `provider/model-*` (provider with model glob; `*` matches any characters)
  3. `model` or `*/model` (exact model on any provider)
  4. `model-*` or `*/model-*` (model glob on any provider)
  5. `provider/*` (all models of a provider)
  6. `*` (all models)

  Ties within a level break by most literal characters, then earliest position in the file. Unset fields in the winning override fall back to the top-level `tps` and `ttft` (matching overrides are never merged).

**Removed keys:** `labels`, `summaryMode`, top-level `thresholds`, and array-valued overrides from earlier releases each produce one warning and are ignored. To keep the old TPS colouring, move `thresholds` to `tps.absolute` with `"tps": { "mode": "absolute" }`, and rewrite `"key": [...]` overrides as `"key": { "tps": { "mode": "absolute", "absolute": [...] } }`.

<!-- example-config: test/config.test.ts loads this block and expects no warnings -->
```json
{
	"separator": " · ",
	"baseColor": "muted",
	"animation": { "enabled": true, "intervalMs": 120 },
	"tps": {
		"mode": "relative",
		"relative": [
			{ "min": 0, "color": "error" },
			{ "min": 50, "color": "warning" },
			{ "min": 80, "color": "success" }
		]
	},
	"ttft": { "mode": "absolute" },
	"overrides": {
		"anthropic/claude-opus-*": {
			"ttft": { "absolute": [{ "min": 0, "color": "success" }, { "min": 8, "color": "warning" }, { "min": 15, "color": "error" }] }
		},
		"gpt-5*": { "tps": { "mode": "absolute" } },
		"ollama/*": {
			"tps": { "mode": "absolute", "absolute": [{ "min": 0, "color": "#ff8800" }, { "min": 15, "color": "accent" }] }
		}
	}
}
```

## Measurement

All durations use a monotonic clock (`performance.now`).

- **Run:** starts at the first `agent_start` after the previous run settled and ends at `agent_settled`. Runs in which no request was measured (for example only errors) are not recorded.
- **Request scope:** measured from `before_provider_request` during an active agent turn to that turn's assistant `message_end`. Cache warming, compaction, and branch summaries run outside turns and are ignored, as are model calls made by tools after `message_end`. A repeat `before_provider_request` before streaming starts is treated as a retry and restarts the measurement; one arriving after deltas have started is ignored.
- **Model identity:** starts under the selected model and switches to the model named in `message_start` (the physical model behind a virtual one), which then governs calibration, averages, and colour overrides. The record stores the serving model and, when different, the selected model as `requested`.
- **TTFT:** request start to the first non-empty text, thinking, or tool-call delta, or to `thinking_start` when that first delta is thinking and `thinking_start` arrived earlier. An empty thinking block does not end TTFT. Time to first visible text/tool call (`ttftTextMs`) and time to response headers (`headersMs`) are also recorded.
- **Thinking phases:** open at `thinking_start` (or at a thinking delta when no start event came first) and close at `thinking_end`, at the next non-thinking event (`text_start`, `toolcall_start`, output delta), or at request end. *Thinking time* is the summed wall time of all thinking phases, silences included. Each record marks `thinking` as `none`, `hidden` (phases without deltas), or `streamed`.
- **Output span and stalls:** the *output span* is the sum of intervals between consecutive output deltas (text and tool-call arguments) within one phase, excluding stalls. A gap of 500 ms or more between consecutive output deltas is a stall (consecutive stalled gaps form one stall event). The wait before the first delta (TTFT), gaps inside a thinking phase, and gaps across phase changes are neither part of the output span nor stalls.
- **Thinking tokens:** `usage.reasoning` when positive (capped at `usage.output`), or the calibrated thinking estimate when thinking was streamed. A reported `0` next to streamed thinking means "no breakdown" rather than "no reasoning" (OpenAI-compatible backends like Ollama and llama.cpp always report `0`). Visible output is `outputTokens` minus `thinkingTokens`.
- **Generation time and settled TPS:** calculated when generation time is at least 1 s.
  - *With a thinking phase:* generation time is thinking time plus the output span, and generated tokens are `usage.output` (which includes reasoning and any initial output backlog produced during thinking).
  - *Without a thinking phase:* uses the live TPS counting rules over the whole request. Generation time is the counted output time (output span minus the 300 ms backlog windows after the first delta and after stalls). Generated tokens are `(usage.output − usage.reasoning)` multiplied by the share of the arriving output estimate counted outside backlog windows (both are 0 when no output estimate arrived, for example whitespace only).
  - When `usage.output` is missing, calibrated estimates are used and the record is marked `estimated`. Negative or non-finite usage numbers are treated as 0. The record also keeps `outputTps` (visible output over output span) and `thinkingTps` (thinking tokens over thinking time).
- **Live TPS:** the generation rate over the trailing 5 s.
  - Deltas arriving less than 1 ms apart count as a single network read.
  - Each delta's calibrated tokens (output and thinking, each with its own ratio) are attributed to the interval since the previous delta of the same phase; intervals crossing the 5 s boundary are clipped and their tokens prorated.
  - The first delta of a phase, intervals across a phase change, and output stalls (500 ms or more) count neither tokens nor time.
  - A delta that starts a phase or ends an output stall opens a fixed 300 ms *backlog window* so text buffered during TTFT, thinking, or a stall (typically flushed within about 150 ms) does not spike the rate. No time inside the 300 ms window counts, and intervals reaching into it count only the part after it, with tokens prorated.
  - Time since the last delta counts (outside backlog windows) while output flows without a stall.
  - While a streamed thinking phase is open, live TPS instead shows calibrated thinking tokens divided by thinking time so far (starting at 1.5 s of thinking time), because reasoning summaries arrive in chunks seconds apart. Once the phase closes, the 5 s window applies again with thinking intervals included.
  - Outside streamed thinking, live TPS is `-` until the window holds 1.5 s of counted time (1.8 s after output starts, including the 300 ms backlog window) and during open hidden thinking. After continuous output, it stays visible through pauses up to 3.5 s and reappears 1.8 s after output resumes from a longer pause.
- **Averages:** computed per `<provider>/<model>` over settled requests on the branch, replayed oldest first:
  - **TPS average:** non-burst requests with at least 1 s of generation time (shorter requests, typically brief tool calls whose reported usage includes unstreamed framing, have no rate).
  - **Burst average:** throughput of burst requests.
  - **TTFT average:** all settled requests, bursts included.
  - Only positive samples count: TTFT is rounded to whole milliseconds, so a first token within 0.5 ms gives 0 and is skipped, because an average of 0 could never move again.
  - The first 10 samples form a plain mean (diluting cold starts). From the 11th sample on, each value is clamped to `[average / 3, average × 3]` and blended with weight 0.1, so the average reflects roughly the last 20 requests and a single outlier shifts it by at most +20% or −6.7%.
  - Averages update as soon as a request ends, before the `working` state is shown. Aborted requests are excluded.
- **Session totals:** summed over all runs on the branch (aborted and burst runs included): runs and their wall-clock time, requests, input tokens (including cache reads and writes), cache reads, visible output tokens, thinking tokens, and cost (`usage.cost.total` when greater than zero).
- **Burst detection:** evaluated on output deltas only (deltas less than 1 ms apart form one batch). The output stream's token count is `usage.output − usage.reasoning` (when `usage.reasoning` is positive), `usage.output` (when no thinking phase was observed and no reasoning was reported), or the calibrated output estimate otherwise. A request is flagged as `burst` when any of the following holds:
  - `few-batches`: an output stream of at least 50 tokens arrived in fewer than 5 batches (including 0 deltas).
  - `cluster`: the output stream lasted more than 1 s and one 100 ms window carried at least 50 % of the arriving output tokens (estimate corrections are not arriving tokens). The windows skip the deltas of the 300 ms backlog window that opens each output phase, but the share is still taken of all arriving output tokens, so an answer that starts with a thinking phase's backlog is not a burst, while a flush after a stall still is.
  - `rate`: generation rate exceeds 10 000 tok/s.
  - Bursts are excluded from calibration and the TPS average; they feed the burst average, TTFT average, and session totals.
- **Aborted, errored, and deferred requests:** aborted requests (Escape) save a partial record (`outcome: "aborted"`) that counts toward session totals but not calibration or averages. Errored and deferred requests produce no record; the run stays in the `working` state until the next request (such as an automatic retry).

### Thinking by backend

How much of the thinking phase pi-tps can time depends on what Pi's provider adapter exposes (Pi 1.1):

| Backend | Start of a thinking block | Hidden reasoning | `usage.reasoning` |
|---|---|---|---|
| Anthropic | real (`content_block_start` of a `thinking` or `redacted_thinking` block) | timed | only when the response carries `thinking_tokens`, else absent |
| OpenAI Responses (and Azure, Codex) | real (reasoning item added), also when no summary is requested | timed | always, `0` when not reported |
| OpenAI Completions (Ollama, llama.cpp, vLLM, most proxies) | synthesised at the first thinking chunk | not visible | always, `0` when not reported (Ollama and llama.cpp never report it) |
| Google (Gemini, Vertex) | synthesised at the first thinking chunk | not visible | always, `0` when not reported |
| Mistral, Amazon Bedrock | synthesised at the first thinking chunk | not visible | absent |

When the start event is synthesised at the first thinking chunk, any thinking before that chunk remains in TTFT. That delay is negligible for models that stream chain-of-thought token by token, but can be several seconds for models that stream summaries (such as Gemini), making their measured rate an upper bound.

### Estimation and calibration

Each stream (thinking, text, tool-call arguments) is estimated incrementally with tokenx. Only the last segment (a run of word characters, or of whitespace and ASCII punctuation) stays open; earlier segments are fixed and counted once. After every delta, the running total matches tokenx's estimate of the full text received so far, unless a single unbroken segment exceeds 512 characters (digits, whitespace, or CJK text without ASCII punctuation), which is split into 256-character pieces to keep per-delta work fast. If a delta reduces the total (for example appending `n` to digits turns a number into a word), the downward correction updates totals only and never enters the live TPS window or burst detection.

Each model learns two ratios via an exponential moving average (α = 0.3; first sample taken as is) from settled, non-burst requests with reported usage and a raw estimate above 50 tokens:

- **Output ratio** (clamped to 0.25–4): compares `usage.output − usage.reasoning` against the text and tool-call estimate when `usage.reasoning` is positive (since streamed thinking is often a summary), or `usage.output` against the total streamed estimate otherwise.
- **Thinking ratio** (clamped to 0.25–100): `usage.reasoning` divided by the raw thinking estimate, updated only when thinking was streamed and `usage.reasoning` is positive. Near 1 for full chain-of-thought models and 50 or more for summary models, scaling live thinking figures toward billed reasoning tokens.

Ratios are stored per `<provider>/<model>` under both the provider-reported `responseModel` and the serving `model` id (so a new request can look up its ratios before `message_start`), and never under a selected virtual model (`requested`).

With `"calibration": false` in the [configuration](#configuration), nothing is learned: live counts and live TPS use the raw estimate (a factor of 1), a request without reported usage records its raw estimate, and the calibration directory is neither read nor written, so none of its warnings appear.

### Limitations

- Tokenx estimates are heuristic: uncalibrated live figures can be off by tens of percent (especially on code and CJK text) until the first calibrating request settles, and summary lengths do not scale linearly with underlying reasoning tokens.
- When a provider reports reasoning tokens without exposing a thinking phase (for example an OpenAI reasoning model behind a Chat Completions proxy that strips `reasoning_content`), thinking time cannot be separated from TTFT: TPS is computed on visible output, no live thinking field appears, and the reasoning tokens are added to the session's `⠿` total.
- On backends that synthesise `thinking_start` at the first chunk (OpenAI Completions, Google, Mistral, Bedrock), thinking before that chunk stays in TTFT, making the settled rate of summary models an upper bound and causing live thinking TPS to start about 1.3–1.5 times too high before settling.
- A real network stall inside a thinking phase cannot be distinguished from silent thinking and is counted as thinking time.
- A proxy that buffers a full chain of thought and flushes it with a short answer (under 50 visible tokens) is not detected as a burst; such short replies have no rate of their own anyway.
- A backlog delivered over more than 300 ms on a slow link partially leaks into the live window and raises live TPS for up to 5 s.
- Without a thinking phase, an answer needs 1.3 s of output span to reach 1 s of counted generation time, so shorter answers have no rate of their own (their tokens still count toward totals).
- Live and settled rates for requests with a thinking phase are computed differently: the settled rate divides `usage.output` by thinking time plus the full output span (backlog included) and is the authoritative figure used for averages.
- TPS includes thinking: relative colours compare like with like within a model, whereas absolute thresholds judge summary and hidden-reasoning models by their reasoning speed (use per-model `overrides` if needed). Models with hidden thinking include thinking time in both live TTFT and average TTFT, keeping relative TTFT colours consistent.
- Relative colours compare a request against the model's own average rather than an absolute speed target; set `mode` to `"absolute"` globally or per model to colour by raw speed.
- Averages are computed from the current branch only; a new session starts without averages even if the model was used in other sessions.
- `x̄` uses a combining macron (`U+0304`), which `pi-tui` counts as one column; some terminal fonts render the macron slightly off-centre.
- `↑`, `↓`, and `◎` are East Asian ambiguous-width characters; terminals configured to render them double-wide will misalign the footer because `pi-tui` counts them as one column.
- Cross-session calibration requires filesystem hard links (supported on all standard local filesystems); without them, calibration stays in memory per session after one warning.
- Providers or proxies that emit chunks separated by 500 ms or more produce a very short active output span, leaving TPS based on little data or unavailable.
- A model call made by another extension between a turn's `before_provider_request` and the start of its stream is treated as a retry.
- Run records are written when a run settles: quitting Pi mid-run loses that run, and navigating `/tree` to an entry inside a run shows totals up to the previous run.
- Session records and calibration files from format version 1 (earlier pi-tps releases) are ignored: resumed sessions show no historical data from v1 runs, and calibration starts fresh once.

### Files

| Location | Written | Purpose |
|---|---|---|
| `~/.pi/agent/pi-tps.json` | never (user-edited) | Configuration (see [Configuration](#configuration)). |
| `~/.pi/agent/pi-tps-calibration/` | after each calibrating request | Shared per-model calibration snapshots (`0000000001.json`, …). |
| session file | when a run settles | `custom` entry with `customType: "pi-tps"` holding the `RunRecord` (about 0.5 KB per request). |

**How `~/.pi/agent/pi-tps-calibration/` works:**

- Each snapshot file (`0000000001.json`, …) contains `{ "version": 2, "models": { "<provider>/<model>": { "output"?: { "ratio", "samples", "updatedAt" }, "thinking"?: { … } } }, "writers": { … } }`. The newest valid file is active, and only the newest three files are kept. Version 1 files from older releases are ignored without a warning.
- Updates are lock-free using atomic hard links. Each session numbers its calibration samples sequentially, and `writers` maps each session id to the highest sample number folded into that snapshot.
- To publish an update, a session writes a temporary file derived from the newest snapshot and hard-links it to the next sequence number. Because old snapshot numbers are deleted and can be reused, link creation alone does not confirm a write: a sample counts as stored only when the newest snapshot's `writers` map records its number. Otherwise, the session reapplies its unconfirmed samples on top of the newest snapshot and retries, ensuring concurrent sessions never overwrite, revert, or double-count samples.
- A session removes its `writers` entry on shutdown; entries from crashed sessions expire after 7 days. A session suspended for more than 6 days between publishing and verifying drops its unconfirmed samples rather than risk applying them twice.
- A corrupt newest snapshot is skipped with one warning. If writing fails, pi-tps warns once per session, keeps the samples in memory, and retries on the next update and at session exit.

## Event bus

Other extensions can subscribe with `pi.events.on(channel, handler)`. TypeScript interfaces are exported from `src/telemetry.ts`; all payloads are read-only. In `rpc`, `json`, and `print` modes, pi-tps measures, persists, and broadcasts events as usual, but never calls `setStatus`.

| Channel | Direction | Payload |
|---|---|---|
| `pi-tps:status` | emitted | `StatusSnapshot` on every state change and animation tick while a run is active, and `null` on session shutdown. Unaffected by `/tps` visibility. |
| `pi-tps:telemetry` | emitted | `RequestRecord` when a request settles or aborts, whether or not `persist` is enabled. |
| `pi-tps:run` | emitted | `RunRecord` when a run settles (identical to the persisted session entry), whether or not `persist` is enabled. |
| `pi-tps:request` | listened | Any payload triggers an immediate re-emit of the current `StatusSnapshot` on `pi-tps:status`. |

`StatusSnapshot` is one of:

- `{ phase: "waiting" | "streaming", provider, model, request, elapsedMs, ttftMs?, liveTps?, outputTokens, thinkingTokens?, thinkingMs?, thinking, average }` for the request in flight: `provider` and `model` name the serving model, `ttftMs` is absent until content arrives, `thinking` is `none`, `hidden`, or `streamed`, and `average` holds the serving model's averages excluding this request.
- `{ phase: "working", elapsedMs, requests, outputTokens, average }` between requests of a run, with the current model's averages.
- `{ phase: "idle", average, session? }` when no run is active, with the current model's averages and (when the branch has recorded runs) `session`: `{ runs, elapsedMs, requests, inputTokens, cacheReadTokens, cacheWriteTokens, visibleOutputTokens, thinkingTokens, cost?, lastAborted }` (`inputTokens` excludes cache reads and writes, matching the records; `lastAborted` is the outcome of the last run).

In all variants, `average` is `{ tps?, burstTps?, ttftMs? }`, with each field present once the model has a sample of it.

`RunRecord` (`version: 2`) holds `startedAt`, `elapsedMs`, `aborted`, and `requests`. Each `RequestRecord` in `requests` holds:

- Identity and outcome: `timestamp`, `provider`, `model` (serving model), `responseModel?`, `requested?` (`{ provider, model }` when the selected model differs from the serving model, as behind a virtual model; absent in records from earlier versions, which read as sent under `model`), `outcome` (`settled` | `aborted`), `burst`, `burstReason?` (`few-batches` | `cluster` | `rate`).
- Timings and rates: `ttftMs?`, `ttftTextMs?`, `headersMs?`, `elapsedMs`, `outputMs`, `generationMs` (thinking time plus output span, or counted output time without backlog windows when no thinking phase occurred), `generatedTokens` (tokens counted in `tps`; possibly fractional when prorated outside backlog windows), `tps?`, `outputTps?`, `thinkingTps?`, `throughputTps?`, `thinkingMs?`, `clockSkewMs?`.
- Tokens, stalls, and cost: `thinkingTokens?`, `thinking` (`none` | `hidden` | `streamed`), `estimated` (no reported `usage.output`; streamed thinking without a positive `reasoningTokens` also has estimated `thinkingTokens`), `inputTokens`, `outputTokens` (including thinking), `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens?`, `deltaCount`, `stallCount`, `stallMs`, `cost?`.

Session entries with another `version` or another `customType` (such as `"tps"` from other extensions) are ignored.

## License

[AGPL-3.0-only](https://github.com/ZeroClover/pi-extensions/blob/master/LICENSE)
