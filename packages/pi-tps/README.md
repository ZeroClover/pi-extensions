# pi-tps

Generation-speed readout for Pi's footer. pi-tps measures every assistant request of an agent run: time to first token, thinking and output, the generation rate in tokens per second (thinking included), stalls, and burst delivery (a proxy that buffers the response and flushes it at once). While a request streams it shows live figures; while tools run it shows the run's progress; when Pi has finished the whole prompt it shows one summary of the run. Streamed tokens are estimated with [tokenx](https://github.com/johannschopplich/tokenx) and calibrated per provider and model against the usage the provider reports, so live figures converge on real token counts. Each run is stored in the session, so the last summary and the session average survive resume, `/reload` and `/tree`.

## Install

Releases are published to npm as `@zeroclover/pi-tps`, versioned independently of the other packages in this repository. Each release is tagged `@zeroclover/pi-tps@<version>` and its notes are the matching section of the package's `CHANGELOG.md`.

```bash
pi install npm:@zeroclover/pi-tps             # install a published version for the user
pi -e ./packages/pi-tps                       # try a repository checkout for one session
pi install /absolute/path/to/packages/pi-tps  # install a repository checkout for the user
```

## Provides

| Kind | Name | Description |
|---|---|---|
| command | `/tps` | Show or hide the readout. Measurement, persistence and broadcasts continue while hidden. |
| command | `/tps mode` | Switch the idle readout between the last run's summary and the session average. |
| command | `/tps mode last` / `/tps mode session` | Set the idle readout explicitly. |
| status | `pi-tps` | The readout, written to the footer with `ctx.ui.setStatus` (interactive mode only). |
| session entry | `customType: "pi-tps"` | One record per run; never sent to the model. |
| events | `pi-tps:status`, `pi-tps:telemetry`, `pi-tps:run`, `pi-tps:request` | Event-bus contract for other extensions (below). |

Visibility and mode last until the extension runtime is replaced (`/reload`, session switch), which restores `enabled` and `summaryMode` from the configuration.

## Reading the readout

The readout is one line in Pi's footer, on the status line it shares with other extensions. It follows the **run**: everything Pi does for one prompt, from the moment you send it until Pi stops on its own. That covers every request to the model, every tool call between them, automatic retries and queued follow-ups. While the run is active the line shows what is happening right now; when the run has finished it shows one summary of the whole run. pi-tps never shows an average in the middle of a run, because the requests of one prompt (thinking, tool calls, the final answer) differ too much for a running average to mean anything.

Every field exists in two styles: `text` (the default) names it with a short word, `symbols` (`"labels": "symbols"` in the [configuration](#configuration)) marks it with one character. Both styles show the same fields in the same order.

### What you see during a run

A spinner (`⠋⠙⠹…`) at the start of the line means a run is active. The line then goes through these states, repeating the first three for every request of the run:

| State | Example (text) | Example (symbols) | When |
|---|---|---|---|
| Waiting | `⠋ TTFT 1.2s` | `⠋ ⇥1.2s` | A request has been sent and nothing has come back yet. `TTFT` counts up. |
| Streaming | `⠙ TPS 48.6 tok/s · TTFT 1.2s · out 1.2K · think 1.9K 4.0s · req 2` | `⠙ »48.6/s ⇥1.2s ↓1.2K ✻1.9K 4.0s ×2` | The model is thinking or answering. Figures are for this request only and update about ten times a second. |
| Streaming, hidden thinking | `⠙ TPS — · TTFT 4.2s · think 4.0s` | `⠙ »— ⇥4.2s ✻4.0s` | The model is thinking without showing its thoughts (for example OpenAI's reasoning models). Only the thinking time is known; `TTFT` keeps counting until the first content arrives. |
| Working | `⠹ run 12.3s · req 1 · out 1.6K` | `⠹ 12.3s ×1 ↓1.6K` | Between two requests, usually while a tool runs. No speed is shown because nothing is being generated. |
| Summary | `TPS 110.5 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%) · out 1.4K · think 94 4.1s · stall 1.2s×1 · req 3 · $0.0018` | `✓ »110.5/s ⇥0.7s 18.4s ↑6.2K ↻92% ↓1.4K ✻94 4.1s ‖1.2s×1 ×3 $0.0018` | The run has finished. The line stays until the next run starts. |

When idle, `/tps mode session` replaces the last run's summary with the session average, and `/tps mode last` switches back:

| State | Example (text) | Example (symbols) | When |
|---|---|---|---|
| Session | `session · TPS 110.0 tok/s · TTFT 0.6s · in 40K · out 6.2K · runs 3 · $0.050` | `Σ »110.0/s ⇥0.6s ↑40K ↓6.2K ×3 $0.050` | Idle in `session` mode: all runs on the current branch together. |
| No data | `TPS — · TTFT —` (`session · TPS — · TTFT —` in session mode) | `· »— ⇥—` (`Σ »— ⇥—`) | Nothing measured yet on this branch. |

Two variants of the summary:

| Variant | Example (text) | Example (symbols) | Meaning |
|---|---|---|---|
| Aborted | `aborted · TPS 47.0 tok/s · TTFT 0.6s · 5.0s · out 64 · req 1` | `✗ »47.0/s ⇥0.6s 5.0s ↓64 ×1` | You pressed Escape. The figures cover what had arrived until then. |
| Burst only | `burst 225.0 tok/s · TTFT 4.0s · 4.0s · in 3.1K · out 900 · req 1` | `✓ ↯225.0/s ⇥4.0s 4.0s ↑3.1K ↓900 ×1` | Every answer of the run arrived in one piece instead of streaming (typically a proxy that buffers responses), so the generation speed cannot be measured. |

### Fields

Each field appears only when it has a value; the table says in which states. Fields come in order of importance, so when the footer is too narrow Pi cuts the line from the end.

| Text | Symbol | Shown in | Meaning |
|---|---|---|---|
| `TPS 48.6 tok/s` | `»48.6/s` | Streaming, summary, session | **Generation speed**: tokens the model generated per second, thinking included. While streaming it is the thinking and output that arrived in the last 5 seconds divided by the generating time in those 5 seconds; it starts as soon as thinking or output has streamed for 1.5 s and shows `—` before that and while the model thinks without showing its thoughts. Pauses in the output (see `stall`) are left out of it, and so is the very first piece of each phase, whose tokens were generated while you were still waiting. In a summary it is every token the provider counted (thinking included) divided by the time the model spent generating them: its thinking time plus its writing time, over the requests that generated for at least one second, so waiting for the first token and pauses do not count and longer requests weigh more. When a provider reports thinking tokens but shows no thinking phase, their time is unknown, so they are left out of the speed (see `think`). The figure is coloured by speed: by default the theme's error colour below 30 tok/s, its warning colour from 30 and its success colour from 80 (red, yellow and green in most themes; see `thresholds`). |
| `burst 225.0 tok/s` | `↯225.0/s` | Summary, session | Replaces `TPS` when every request of the run arrived in one piece: output tokens divided by the whole time from sending the request to the end, waiting included. It describes delivery, not generation speed, so it is never coloured. |
| `TTFT 1.2s` | `⇥1.2s` | Waiting, streaming, summary, session | **Time to first token**: from sending a request until the first piece of the answer (text, thinking or tool call) arrives; when that piece is thinking and the provider announced the start of the thinking block earlier, until that announcement. It counts up while waiting (also while the model thinks without showing it) and freezes when the first piece arrives. Summaries show the average over the run's requests. |
| `18.4s` | `18.4s` | Summary | **Run duration**: wall-clock time from sending the prompt until Pi finished, including tool execution and waiting. This is the only field without a label. |
| `run 12.3s` | `12.3s` | Working | Time since the run started. Keeps counting while tools execute. |
| `in 6.2K (cache 92%)` | `↑6.2K ↻92%` | Summary, session | **Input tokens** sent to the model, added up over every request. Each request re-sends the conversation, so a run of several requests sends the context several times; this is what you pay for. Cached tokens are included. The percentage in parentheses (`↻`) is the share of that input read from the provider's prompt cache, which is cheaper and faster; it is left out when nothing came from the cache. Left out entirely when no input was reported (for example a run aborted before the first answer). |
| `out 1.4K` | `↓1.4K` | Streaming, working, summary, session | **Output tokens** the model wrote as answer text and tool-call arguments, without thinking. While streaming it is an estimate for the current request; while working, the total of the run's finished requests; in summaries, the total reported by the provider. |
| `think 94 4.1s` | `✻94 4.1s` | Streaming, summary | **Thinking**: the number of reasoning tokens, then how long the model spent thinking (from the start to the end of its thinking blocks, silences included). While the model thinks without showing its thoughts only the time is shown (`think 4.0s`), and so does a summary whose provider reported no thinking count for such thinking. The time is left out when the provider reports thinking tokens but shows no thinking phase, or when it is under 0.05 s. |
| `stall 1.2s×1` | `‖1.2s×1` | Summary | **Pauses** in the middle of the written answer: the total time the output stopped for half a second or more, then how many times it stopped. Silence while the model thinks is thinking, not a pause. Shown only when the output paused; this time is excluded from `TPS`. |
| `req 2` | `×2` | Waiting, streaming | **Which request** of the run this is. Shown from the second request on. |
| `req 1` | `×1` | Working, summary | **How many requests** the run has made so far, or made in total. Requests that failed with an error do not count. |
| `runs 3` | `×3` | Session | **How many runs** (prompts) the session average covers. |
| `$0.0018` | `$0.0018` | Summary, session | **Cost** in US dollars, added up. Shown only for models that have a price in Pi. |

### Markers

| Text | Symbol | Meaning |
|---|---|---|
| `⠋⠙⠹…` | `⠋⠙⠹…` | A run is active. Turning animation off shows the first frame without rotating. |
| (none) | `✓` | Summary of a finished run. |
| `aborted` | `✗` | Summary of a run you stopped with Escape. |
| `session` | `Σ` | Session average instead of the last run. |
| (none) | `·` | No run measured yet. |
| `~` before a number | `~` before a number | The number rests on an estimate. While streaming: pi-tps has not yet learned how this model counts that kind of token (answer and thinking are learned separately), so the figure may be off by tens of percent; `out` and `think` are marked by their own kind, the speed while tokens of an unlearned kind are in its window. In a summary: the provider did not report the numbers needed for some request, so part of the figure was estimated; a speed is marked when a request it was computed from had no reported output count, `out` and `think` also when thinking tokens had to be estimated because the provider reported none. |
| `—` | `—` | Not known: not measured yet, or not measurable (for example a run with only very short answers). |

Except for the speed, every field uses the base colour (`dim` by default, see `baseColor`).

### One line, field by field

The summary `TPS 110.5 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%) · out 1.4K · think 94 4.1s · stall 1.2s×1 · req 3 · $0.0018`, or `✓ »110.5/s ⇥0.7s 18.4s ↑6.2K ↻92% ↓1.4K ✻94 4.1s ‖1.2s×1 ×3 $0.0018` in the symbol style, reads:

1. `✓` (symbols only): the run has finished normally.
2. `TPS 110.5 tok/s` / `»110.5/s`: while thinking and writing, the model generated 110.5 tokens per second.
3. `TTFT 0.7s` / `⇥0.7s`: on average each request waited 0.7 s for its first token.
4. `18.4s`: the whole prompt took 18.4 s from sending to finished, tools included.
5. `in 6.2K (cache 92%)` / `↑6.2K ↻92%`: the three requests sent 6 200 input tokens in total, 92 % of them from the prompt cache.
6. `out 1.4K` / `↓1.4K`: the model wrote 1 400 tokens of answer and tool calls.
7. `think 94 4.1s` / `✻94 4.1s`: it also produced 94 thinking tokens and spent 4.1 s thinking.
8. `stall 1.2s×1` / `‖1.2s×1`: the stream paused once, for 1.2 s.
9. `req 3` / `×3`: the prompt took three requests (for example two tool calls and the final answer).
10. `$0.0018`: the run cost 0.18 US cents.

### Number formats

Token counts below 1000 are exact; larger ones use `K` (thousand), `M` (million) and `B` (billion) with one decimal, dropping `.0` (`1.2K`, `40K`). Durations show one decimal below a minute (`18.4s`), then the two largest units (`1m 30s`, `2h 15m`, `3d 12h`). Speeds always show one decimal. Costs show four decimals below one cent, three below one dollar, then two.

## Measurement

All durations come from a monotonic clock (`performance.now`).

- **Run.** Starts at the first `agent_start` after the previous run settled and ends at `agent_settled`. A run in which no request was measured (for example one that only errored) is not recorded.
- **Request scope.** A request is measured from `before_provider_request` while an agent turn is active to the turn's assistant `message_end`. Cache warming, compaction and branch summaries run outside turns and are ignored, as are model calls that tools make after the assistant message ended. A repeated request before the stream started is taken for a retry and restarts the measurement; a request starting while the stream delivers deltas is ignored.
- **Model identity.** The request starts under the selected model and switches to the model named in the assistant `message_start`: behind a virtual model that is the physical model, whose calibration ratio and thresholds then apply.
- **TTFT**: request start to the first non-empty text, thinking or tool-call delta; when that delta is thinking and its block began with a `thinking_start` event, request start to that event. A thinking block that streams nothing does not end the wait. The time to the first visible text or tool call and the time to response headers are kept in the record.
- **Thinking phases.** A thinking phase opens at `thinking_start` (or at a thinking delta when no start came first) and closes at `thinking_end`, at the next non-thinking event (`text_start`, `toolcall_start`, an output delta) or at the end of the request. The *thinking time* is the summed wall time of the phases, silences included: a model that thinks without streaming its thoughts, or streams a summary in a few chunks, is still thinking. Each record says whether its thinking was `none`, `hidden` (phases without deltas) or `streamed`.
- **Output span.** Output deltas (text and tool-call arguments) have an *active span*: the gaps between consecutive output deltas of one phase. The gap between a thinking phase and the first output delta belongs to neither.
- **Stalls.** A gap of 500 ms or more between two consecutive output deltas is a stall. Consecutive stalled gaps are one stall event. Stall time is excluded from the output span; the gap before the first delta is TTFT, and gaps inside a thinking phase or around a phase change are not stalls.
- **Generation time and rate.** A request's generation time is its thinking time plus its output span. Its TPS is its *generated tokens* over that time, when the time is at least 1 s: `usage.output` (which always includes reasoning) when a thinking phase was observed, else `usage.output` minus the reported reasoning tokens, because their time is hidden in TTFT and not guessed. Without `usage.output` the calibrated estimate is used and the figure is marked estimated. The record also keeps `outputTps` (visible output over the output span) and `thinkingTps` (thinking tokens over the thinking time). Negative or non-finite usage counts are treated as 0.
- **Thinking tokens.** `usage.reasoning` when it is positive (capped at the output), else, when thinking was streamed, the calibrated thinking estimate (marked estimated). A reported `0` next to streamed thinking means "no breakdown", not "no reasoning": OpenAI-compatible backends such as Ollama and llama.cpp always report 0. Visible output is the output minus the thinking tokens.
- **Live TPS.** The generation rate over the last 5 s. Each delta's calibrated tokens (output and thinking, each kind with its own ratio) are attributed to the interval since the previous delta of the same phase; intervals are clipped to the window and their tokens prorated by the share inside it. The first delta of a phase, intervals across a phase change and output stalls count neither tokens nor time, so the first chunk (generated during TTFT) does not inflate the start. The time since the last delta counts while a thinking phase that has streamed is open, or while output flows without a stall. Deltas of one network read (less than 1 ms apart) are one arrival. The figure is unavailable until the window holds 1.5 s of counted time and while a thinking phase without deltas is open; after continuous output it survives a pause of up to 3.5 s and returns 1.5 s after output resumes from a longer one.
- **Run and session TPS.** Summed generated tokens over summed generation time, over settled, non-burst requests with at least 1 s of generation time. This equals the requests' own rates averaged with their generation times as weights, so a request, a run of one request and a session of one run show the same figure. Shorter requests, typically tool calls without thinking, are left out: their reported output includes tool-call framing that is never streamed, which would inflate the rate; a tool call after a few seconds of thinking does count. Aborted requests are used only when nothing else qualifies, so an aborted run still shows a rate. When every request was a burst, the burst throughput (output tokens over elapsed time) is shown instead; otherwise the TPS is `—`.
- **Run and session sums.** TTFT is the mean over non-aborted requests (aborted ones when there are no others); tokens, thinking tokens and time, stalls and cost are summed over all requests, aborted and burst ones included.
- **Burst.** Only output deltas are burst evidence: a thinking summary arrives in a few chunks at the provider's cadence. Output deltas less than 1 ms apart arrived in one network read and form one batch. A request is burst delivery when its output stream of at least 50 tokens arrived in fewer than 5 batches (including no deltas at all; shorter replies are just too short to measure), when one 100 ms window carries at least 50 % of its arriving output tokens (estimate corrections excluded) while the output stream (first to last output delta) lasted more than 1 s, or when its generation rate exceeds 10 000 tokens per second. The output stream's token count is `usage.output` minus a positive `usage.reasoning`; `usage.output` alone when no thinking phase was observed and no reasoning was reported; otherwise the calibrated estimate of the output deltas. Bursts are excluded from calibration and TPS.
- **Aborted** requests (Escape) keep a partial record. They never feed calibration, and they count toward the TPS and mean TTFT only when no settled request qualifies (so an aborted run still shows its partial figures); their tokens and cost always count. **Errored** and **deferred** requests produce no record; the run continues, and the readout shows the working state until the next request, for example Pi's automatic retry.
- **Cost** is taken from `usage.cost.total` only when it is greater than zero.

### Thinking by backend

How much of the thinking pi-tps can time depends on what Pi's provider adapter exposes (Pi 1.1):

| Backend | Start of a thinking block | Hidden reasoning | `usage.reasoning` |
|---|---|---|---|
| Anthropic | real (`content_block_start` of a `thinking` or `redacted_thinking` block) | timed | only when the response carries `thinking_tokens`, else absent |
| OpenAI Responses (and Azure, Codex) | real (reasoning item added), also when no summary is requested | timed | always, `0` when not reported |
| OpenAI Completions (Ollama, llama.cpp, vLLM, most proxies) | synthesised at the first thinking chunk | not visible | always, `0` when not reported (Ollama and llama.cpp never report it) |
| Google (Gemini, Vertex) | synthesised at the first thinking chunk | not visible | always, `0` when not reported |
| Mistral, Amazon Bedrock | synthesised at the first thinking chunk | not visible | absent |

Where the start is synthesised, the thinking before the first chunk stays in TTFT. For a model that streams its chain of thought token by token that is negligible; for one that streams a summary (Gemini) it can be seconds, so the request's rate is then an upper bound.

### Estimation and calibration

Each stream (thinking, text, tool-call arguments) is estimated incrementally with tokenx. Only the last segment (a run of word characters, or of whitespace and ASCII punctuation) stays open; everything before it can no longer change and is counted once. After every delta the running total equals tokenx's estimate of the whole text received so far, whatever the delta sizes, so a delta can also correct the total downwards (appending `n` to a digit run turns a number into a word). Such a correction changes the totals only; it is not counted as tokens arriving, so it never enters the live window or the burst detection. This holds as long as no single segment is longer than 512 characters; a longer one (an unbroken run of digits, whitespace, or CJK text without ASCII punctuation) is counted in 256-character pieces to keep each delta cheap, and its estimate can then differ from tokenx's estimate of the whole run.

Each model has two ratios, learned separately with the same exponential moving average (α = 0.3; the first sample is taken as is), from settled, non-burst requests with reported usage and a raw estimate above 50 tokens:

- **Output ratio**, clamped to 0.25–4. With a positive `usage.reasoning` the sample compares the visible output with the output estimate (`usage.output − usage.reasoning` against the estimate of text and tool calls), because streamed thinking is often a summary. Without one it compares `usage.output` with the estimate of everything streamed.
- **Thinking ratio**, clamped to 0.25–100: `usage.reasoning` over the raw thinking estimate, only when thinking was streamed and `usage.reasoning` is positive. It is near 1 for models that stream their full chain of thought and can reach 50 or more for models that stream a summary, so the live thinking count and rate of such models approach the reasoning they are billed for instead of the summary's length.

Ratios are stored per `<provider>/<model>` under both the response model and the requested model, so a new request can look its ratios up before the provider names the response model.

### Limitations

- Estimates are heuristic. Uncalibrated live figures (`~`) can be off by tens of percent, most for code and CJK text, until the first calibrating request settles. Summary lengths do not scale linearly with the reasoning behind them, so the thinking ratio of summary models stays noisy.
- When a provider reports reasoning tokens but shows no thinking phase (for example an OpenAI reasoning model behind a Chat Completions proxy without `reasoning_content`), their time cannot be separated from TTFT: the speed then rests on the visible output, and `think` shows the count without a duration.
- Backends that synthesise the start of a thinking block from its first chunk (OpenAI Completions, Google, Mistral, Bedrock; see the table above) hide the thinking before that chunk in TTFT, so the rate of a summary model behind them is an upper bound. Nothing in the stream tells such a start from a real one, so it is not marked.
- A thinking phase with a real network stall is counted as thinking: the two cannot be told apart.
- A proxy that buffers a whole chain of thought and flushes it with a short answer (under 50 visible tokens) is not caught as burst. Such a request has no rate of its own anyway.
- The live rate leaves out the first chunk of each phase; the settled rate rests on `usage.output`, which includes it. The settled figure is the authoritative one.
- The colour thresholds now judge a rate that includes thinking. For models that stream their full chain of thought nothing changes; summary and hidden-reasoning models are judged by their reasoning rate, so per-model `overrides` may need adjusting.
- Calibration needs a filesystem with hard links (all common local filesystems); without them it stays per session, with one warning.
- Providers that deliver text in chunks separated by 500 ms or more (observed with some proxies) have a short active output span, so their TPS rests on little data or is unavailable.
- A model call that another extension makes between the turn's provider request and the start of its stream is taken for a retry.
- A run is written when it settles: quitting Pi in the middle of a run loses that run, and navigating `/tree` to a point inside a run shows the runs before it.
- Records and calibration files of earlier pi-tps versions (format version 1) are ignored: a resumed session shows no data until its next run, and calibration starts over once.

## Configuration

Read from `~/.pi/agent/pi-tps.json` (Pi's agent directory, `getAgentDir()`) at session start; run `/reload` after editing. A missing file means defaults. Invalid JSON or an invalid field produces one warning per problem and falls back to the default for that field only; a bad configuration never disables the readout.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Initial visibility of the readout |
| `persist` | boolean | `true` | Append a `pi-tps` entry per run. When `false`, runs live in memory, start empty at every session start and do not follow `/tree` |
| `labels` | `"text"` \| `"symbols"` | `"text"` | Field labels: words (`TPS 48.6 tok/s · TTFT 1.2s`) or single-cell symbols (`»48.6/s ⇥1.2s`) |
| `summaryMode` | `"last"` \| `"session"` | `"last"` | Initial idle readout: the last run's summary or the session average |
| `baseColor` | colour | `"dim"` | Colour of every field except the TPS |
| `animation.enabled` | boolean | `true` | Rotate the spinner; when `false` the readout redraws only when a value changes |
| `animation.intervalMs` | number from 50 to 1000 | `100` | Refresh interval while a run is active |
| `animation.frames` | non-empty strings without control characters | braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | Spinner frames |
| `thresholds` | threshold list | `0→error, 30→warning, 80→success` | Colour of the TPS (the generation rate, thinking included) |
| `overrides` | object of threshold lists | `{}` | Thresholds per provider and model |

A **threshold list** is an array of `{ "min": number, "color": colour }`, in any order. The TPS uses the colour of the highest `min` not above it (of equal `min`s, the later entry); below the lowest `min`, or with an empty list, it uses `baseColor`. The colour follows the model that produced the figure: the serving model of the live request, the last contributing model of a summary.

A **colour** is a Pi theme token (`success`, `warning`, `error`, `accent`, `dim`, `muted`, `text`, or any other foreground token of the theme), which follows the active theme, or a hex colour `#rgb` / `#rrggbb`, rendered in truecolor or mapped to the nearest palette colour by Pi.

**Override keys** match case-insensitively:

| Key | Matches |
|---|---|
| `provider/model` | that model of that provider |
| `provider/model-*` | models of that provider matching the glob (`*` matches any run of characters) |
| `model`, `model-*` | that model, or matching models, of any provider (`*/model` is the same) |
| `provider/*` | every model of that provider |
| `*` | every model |

When several keys match, the first level in this order wins: exact `provider/model`, `provider/<glob>`, model-only exact, model-only glob, `provider/*`, `*`, then the global `thresholds`. Within one level the pattern with more literal characters wins, then the first in the file. Only the first `/` separates provider and model, so `openrouter/anthropic/claude-*` targets OpenRouter's `anthropic/claude-*` models.

<!-- example-config: test/config.test.ts loads this block and expects no warnings -->
```json
{
	"labels": "symbols",
	"summaryMode": "session",
	"baseColor": "muted",
	"animation": { "enabled": true, "intervalMs": 120 },
	"thresholds": [
		{ "min": 0, "color": "error" },
		{ "min": 30, "color": "warning" },
		{ "min": 80, "color": "success" }
	],
	"overrides": {
		"anthropic/claude-opus-*": [
			{ "min": 0, "color": "error" },
			{ "min": 20, "color": "warning" },
			{ "min": 50, "color": "success" }
		],
		"gpt-5*": [
			{ "min": 0, "color": "warning" },
			{ "min": 100, "color": "success" }
		],
		"ollama/*": [
			{ "min": 0, "color": "#ff8800" },
			{ "min": 15, "color": "accent" }
		]
	}
}
```

### Files

| File | Written | Content |
|---|---|---|
| `~/.pi/agent/pi-tps.json` | never | Configuration (above) |
| `~/.pi/agent/pi-tps-calibration/` | after each calibrating request | Numbered versions `0000000001.json`, … each `{ "version": 2, "models": { "<provider>/<model>": { "output"?: { "ratio", "samples", "updatedAt" }, "thinking"?: { … } } } }`; the newest valid one is the calibration. A newest version in another format (version 1 from earlier pi-tps releases) is ignored without a warning: calibration starts empty and the next update publishes version 2. Each session numbers its samples in order, and each version records per session (`writers`) the highest number applied. An update publishes the next number derived from the newest; the file appears complete and only one session can create a given number. Because old numbers are removed and can be created again, creating a file is not taken as success: a sample counts as stored exactly when the newest version records its number, otherwise the session applies it on top of the newest version and tries again, so no sample is applied twice. Concurrent sessions therefore never overwrite, revert or double-count each other's samples, and no lock is used. A session removes its record when it ends; records of crashed sessions are removed after 7 days. A session paused for more than 6 days between publishing and checking drops its unconfirmed samples instead of risking applying them twice. Only the newest three versions are kept. A corrupt newest version is skipped with one warning; when writing fails, one warning per session, the samples are kept for this session and retried with the next update and when the session ends |
| session file | when a run settles | `custom` entry, `customType: "pi-tps"`, data: the run record (about 0.5 KB per request) |

## Event bus

Other extensions can subscribe with `pi.events.on(channel, handler)`. Types are exported from `src/telemetry.ts`; payloads are read-only.

| Channel | Direction | Payload |
|---|---|---|
| `pi-tps:status` | emitted | `StatusSnapshot` on every state change and every tick while a run is active; `null` only when the session shuts down. Hiding the readout with `/tps` does not change it |
| `pi-tps:telemetry` | emitted | `RequestRecord` of each request as it settles or aborts, with or without persistence |
| `pi-tps:run` | emitted | `RunRecord` of each run as it settles, equal to the persisted entry data, with or without persistence |
| `pi-tps:request` | listened | Any emit makes pi-tps re-emit the current snapshot on `pi-tps:status` |

`StatusSnapshot` is one of `{ phase: "waiting" | "streaming", provider, model, request, elapsedMs, ttftMs?, liveTps?, outputTokens, thinkingTokens?, thinkingMs?, thinking, calibrated, thinkingCalibrated, tpsCalibrated }` (`ttftMs` is absent until content arrived; `thinking` is `none`, `hidden` or `streamed`; the three flags say whether the output count, the thinking count and the live TPS rest on calibrated ratios), `{ phase: "working", elapsedMs, requests, outputTokens, estimated }`, `{ phase: "run", run: RunSummary }`, `{ phase: "session", session: SessionSummary }` or `{ phase: "empty", mode }`.

`RunRecord` (`version: 2`) holds `startedAt`, `elapsedMs`, `aborted` and `requests`. Each `RequestRecord` holds `timestamp`, `provider`, `model`, `responseModel?`, `outcome` (`settled` | `aborted`), `burst`, `burstReason?` (`few-batches` | `cluster` | `rate`), `ttftMs?`, `ttftTextMs?`, `headersMs?`, `elapsedMs`, `outputMs`, `generationMs` (thinking time plus output span), `generatedTokens` (the tokens the rate counts), `tps?` (the generation rate), `outputTps?`, `thinkingTps?`, `throughputTps?`, `thinkingMs?` (thinking time), `thinkingTokens?`, `thinking` (`none` | `hidden` | `streamed`), `estimated` (no reported `usage.output`; streamed thinking without a positive `reasoningTokens` has estimated `thinkingTokens` as well), `inputTokens`, `outputTokens` (including thinking), `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens?`, `deltaCount`, `stallCount`, `stallMs`, `cost?` and `clockSkewMs?`. Entries with another `version` or another `customType` (for example `"tps"` from other TPS extensions) are ignored.

In `rpc`, `json` and `print` modes pi-tps measures, persists and broadcasts, but never calls `setStatus`.

## License

[AGPL-3.0-only](https://github.com/ZeroClover/pi-extensions/blob/master/LICENSE)
