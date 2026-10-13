# pi-tps

Generation-speed readout for Pi's footer. pi-tps measures every assistant request of an agent run: time to first token, thinking and output, live tokens per second, stalls, and burst delivery (a proxy that buffers the response and flushes it at once). While a request streams it shows live figures; while tools run it shows the run's progress; when Pi has finished the whole prompt it shows one summary of the run. Streamed tokens are estimated with [tokenx](https://github.com/johannschopplich/tokenx) and calibrated per provider and model against the usage the provider reports, so live figures converge on real token counts. Each run is stored in the session, so the last summary and the session average survive resume, `/reload` and `/tree`.

## Install

```bash
pi -e ./packages/pi-tps                       # try for one session
pi install /absolute/path/to/packages/pi-tps  # install for the user
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
| Streaming | `⠙ TPS 48.6 tok/s · TTFT 1.2s · out 1.2K · think 1.9K 4.0s · req 2` | `⠙ »48.6/s ⇥1.2s ↓1.2K ✻1.9K 4.0s ×2` | The model is answering. Figures are for this request only and update about ten times a second. |
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
| `TPS 48.6 tok/s` | `»48.6/s` | Streaming, summary, session | **Generation speed**: output tokens per second while the model is actually writing. Waiting for the first token and pauses (see `stall`) do not count. While streaming it is the speed over the last 5 seconds of this request; it shows `—` until 1.5 s after the first visible token, so it also stays `—` while the model only thinks. In a summary it is the speed over all requests of the run that wrote for at least one second, weighted by their tokens; short requests such as tool calls are left out because they are too short to time. The figure is coloured by speed: by default the theme's error colour below 30 tok/s, its warning colour from 30 and its success colour from 80 (red, yellow and green in most themes; see `thresholds`). |
| `burst 225.0 tok/s` | `↯225.0/s` | Summary, session | Replaces `TPS` when every request of the run arrived in one piece: output tokens divided by the whole time from sending the request to the end, waiting included. It describes delivery, not generation speed, so it is never coloured. |
| `TTFT 1.2s` | `⇥1.2s` | Waiting, streaming, summary, session | **Time to first token**: from sending a request until the first piece of the answer (text, thinking or tool call) arrives. It counts up while waiting and freezes when the first token arrives. Summaries show the average over the run's requests. |
| `18.4s` | `18.4s` | Summary | **Run duration**: wall-clock time from sending the prompt until Pi finished, including tool execution and waiting. This is the only field without a label. |
| `run 12.3s` | `12.3s` | Working | Time since the run started. Keeps counting while tools execute. |
| `in 6.2K (cache 92%)` | `↑6.2K ↻92%` | Summary, session | **Input tokens** sent to the model, added up over every request. Each request re-sends the conversation, so a run of several requests sends the context several times; this is what you pay for. Cached tokens are included. The percentage in parentheses (`↻`) is the share of that input read from the provider's prompt cache, which is cheaper and faster; it is left out when nothing came from the cache. Left out entirely when no input was reported (for example a run aborted before the first answer). |
| `out 1.4K` | `↓1.4K` | Streaming, working, summary, session | **Output tokens** the model wrote as answer text and tool-call arguments, without thinking. While streaming it is an estimate for the current request; while working, the total of the run's finished requests; in summaries, the total reported by the provider. |
| `think 94 4.1s` | `✻94 4.1s` | Streaming, summary | **Thinking**: the number of reasoning tokens, then how long the model spent producing them. The time is left out when the provider keeps its thinking hidden (only the token count is known) or when it is under 0.05 s. |
| `stall 1.2s×1` | `‖1.2s×1` | Summary | **Pauses** in the middle of an answer: the total time the stream stopped for half a second or more, then how many times it stopped. Shown only when the stream paused; this time is excluded from `TPS`. |
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
| `~` before a speed | `~` before a speed | The speed rests on an estimate. While streaming: pi-tps has not yet learned how this model counts tokens, so the live figure may be off by tens of percent until the first answer of this model finishes. In a summary: the provider did not report the numbers needed, so part of the figure was estimated. |
| `—` | `—` | Not known: not measured yet, or not measurable (for example a run with only very short answers). |

Except for the speed, every field uses the base colour (`dim` by default, see `baseColor`).

### One line, field by field

The summary `TPS 110.5 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%) · out 1.4K · think 94 4.1s · stall 1.2s×1 · req 3 · $0.0018`, or `✓ »110.5/s ⇥0.7s 18.4s ↑6.2K ↻92% ↓1.4K ✻94 4.1s ‖1.2s×1 ×3 $0.0018` in the symbol style, reads:

1. `✓` (symbols only): the run has finished normally.
2. `TPS 110.5 tok/s` / `»110.5/s`: while writing, the model produced 110.5 tokens per second.
3. `TTFT 0.7s` / `⇥0.7s`: on average each request waited 0.7 s for its first token.
4. `18.4s`: the whole prompt took 18.4 s from sending to finished, tools included.
5. `in 6.2K (cache 92%)` / `↑6.2K ↻92%`: the three requests sent 6 200 input tokens in total, 92 % of them from the prompt cache.
6. `out 1.4K` / `↓1.4K`: the model wrote 1 400 tokens of answer and tool calls.
7. `think 94 4.1s` / `✻94 4.1s`: it also produced 94 thinking tokens, over 4.1 s.
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
- **TTFT**: request start to the first non-empty text, thinking or tool-call delta. The time to the first visible text or tool call and the time to response headers are kept in the record.
- **Phases.** Thinking deltas and output deltas (text and tool-call arguments) are counted separately. Their *active spans* add up the gaps between consecutive deltas of the same kind; the gap where thinking turns into output belongs to neither.
- **Stalls.** A gap of 500 ms or more between deltas is a stall. Consecutive stalled gaps are one stall event. Stall time is excluded from the active spans; the gap before the first delta is TTFT, not a stall.
- **Live TPS.** Calibrated estimated output tokens in the last 5 s, divided by the smaller of 5 s and the time since the first output delta. Unavailable for the first 1.5 s.
- **Request TPS** (in the record): `(usage.output − thinking tokens) / active output span`, when the span is at least 1 s. Thinking tokens are `usage.reasoning` when the provider reports it (capped at the output), else the calibrated thinking estimate. Without `usage.output` the calibrated estimate is used and the figure is marked estimated. Negative or non-finite usage counts are treated as 0.
- **Run and session TPS.** Sum of visible output tokens divided by the sum of active output spans over settled, non-burst requests that streamed output for at least 1 s, so longer streams weigh more. Shorter requests, typically tool calls, are left out: their reported output includes tool-call framing that is never streamed, which would inflate the rate. Aborted requests are used only when nothing else qualifies, so an aborted run still shows a rate. When every request was a burst, the burst throughput (output tokens over elapsed time) is shown instead; otherwise the TPS is `—`.
- **Run and session sums.** TTFT is the mean over non-aborted requests (aborted ones when there are no others); tokens, thinking, stalls and cost are summed over all requests, aborted and burst ones included.
- **Burst.** Deltas less than 1 ms apart arrived in one network read and form one batch. A request is burst delivery when a response of at least 50 output tokens arrived in fewer than 5 batches (including no deltas at all; shorter replies are just too short to measure), when one 100 ms window carries at least 50 % of its estimated tokens while the stream (first to last delta) lasted more than 1 s, or when a computed rate exceeds 10 000 tokens per second. Bursts are excluded from calibration and TPS.
- **Aborted** requests (Escape) keep a partial record, excluded from calibration, TPS and mean TTFT. **Errored** and **deferred** requests produce no record; the run continues, for example with Pi's automatic retry.
- **Cost** is taken from `usage.cost.total` only when it is greater than zero.

### Estimation and calibration

Each stream (thinking, text, tool-call arguments) is estimated incrementally with tokenx: the complete segments before the last word boundary are counted once, only the open trailing segment is re-estimated, and an over-long open segment (digit runs, CJK prose without ASCII separators) is committed in 256-character chunks. The running total therefore stays within 2 % of the estimate of the whole text, whatever the delta sizes.

After every settled, non-burst request with reported usage and a raw estimate above 50 tokens, a sample `reported / estimated` is clamped to 0.25–4 and folded into an exponential moving average (α = 0.3; the first sample is taken as is). With a reasoning breakdown the sample compares visible output only (`usage.output − usage.reasoning` against the output estimate), because streamed thinking is often a summary. Ratios are stored per `<provider>/<model>` under both the response model and the requested model, so a new request can look its ratio up before the provider names the response model.

### Limitations

- Estimates are heuristic. Uncalibrated live figures (`~`) can be off by tens of percent, most for code and CJK text, until the first calibrating request settles.
- Providers that hide or encrypt thinking stream no thinking deltas: TTFT then includes the hidden thinking, and thinking time is unknown (the record has `thinkingObserved: false`).
- Providers that deliver text in chunks separated by 500 ms or more (observed with some proxies) have a short active output span, so their TPS rests on little data or is unavailable.
- A model call that another extension makes between the turn's provider request and the start of its stream is taken for a retry.
- A run is written when it settles: quitting Pi in the middle of a run loses that run, and navigating `/tree` to a point inside a run shows the runs before it.

## Configuration

Read from `~/.pi/agent/pi-tps.json` (Pi's agent directory, `getAgentDir()`) at session start; run `/reload` after editing. A missing file means defaults. Invalid JSON or an invalid field produces one warning per problem and falls back to the default for that field only; a bad configuration never disables the readout.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Initial visibility of the readout |
| `persist` | boolean | `true` | Append a `pi-tps` entry per run. When `false`, runs live in memory, start empty at every session start and do not follow `/tree` |
| `labels` | `"text"` \| `"symbols"` | `"text"` | Field labels: words (`TPS 48.6 tok/s · TTFT 1.2s`) or single-cell symbols (`»48.6/s ⇥1.2s`) |
| `summaryMode` | `"last"` \| `"session"` | `"last"` | Initial idle readout: the last run's summary or the session average |
| `baseColor` | colour | `"dim"` | Colour of every field except the output TPS |
| `animation.enabled` | boolean | `true` | Rotate the spinner; when `false` the readout redraws only when a value changes |
| `animation.intervalMs` | number from 50 to 1000 | `100` | Refresh interval while a run is active |
| `animation.frames` | non-empty strings without control characters | braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | Spinner frames |
| `thresholds` | threshold list | `0→error, 30→warning, 80→success` | Colour of the output TPS |
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
| `~/.pi/agent/pi-tps-calibration.json` | after each calibrating request | `{ "version": 1, "models": { "<provider>/<model>": { "ratio", "samples", "updatedAt" } } }`. Updated under a lock file (`pi-tps-calibration.json.lock`) by re-reading and merging, then replaced atomically, so concurrent sessions keep each other's updates. A corrupt file is treated as empty with one warning; when it cannot be written, one warning per session, and the ratios stay in memory |
| session file | when a run settles | `custom` entry, `customType: "pi-tps"`, data: the run record (about 0.5 KB per request) |

## Event bus

Other extensions can subscribe with `pi.events.on(channel, handler)`. Types are exported from `src/telemetry.ts`; payloads are read-only.

| Channel | Direction | Payload |
|---|---|---|
| `pi-tps:status` | emitted | `StatusSnapshot` on every state change and every tick while a run is active; `null` only when the session shuts down. Hiding the readout with `/tps` does not change it |
| `pi-tps:telemetry` | emitted | `RequestRecord` of each request as it settles or aborts, with or without persistence |
| `pi-tps:run` | emitted | `RunRecord` of each run as it settles, equal to the persisted entry data, with or without persistence |
| `pi-tps:request` | listened | Any emit makes pi-tps re-emit the current snapshot on `pi-tps:status` |

`StatusSnapshot` is one of `{ phase: "waiting" | "streaming", provider, model, request, elapsedMs, ttftMs?, liveTps?, outputTokens, thinkingTokens?, thinkingMs?, calibrated }`, `{ phase: "working", elapsedMs, requests, outputTokens }`, `{ phase: "run", run: RunSummary }`, `{ phase: "session", session: SessionSummary }` or `{ phase: "empty", mode }`.

`RunRecord` (`version: 1`) holds `startedAt`, `elapsedMs`, `aborted` and `requests`. Each `RequestRecord` holds `timestamp`, `provider`, `model`, `responseModel?`, `outcome` (`settled` | `aborted`), `burst`, `burstReason?` (`few-batches` | `cluster` | `rate`), `ttftMs?`, `ttftTextMs?`, `headersMs?`, `elapsedMs`, `outputMs`, `outputTps?`, `thinkingTps?`, `throughputTps?`, `thinkingMs?`, `thinkingTokens?`, `thinkingObserved`, `estimated`, `inputTokens`, `outputTokens` (including thinking), `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens?`, `deltaCount`, `stallCount`, `stallMs`, `cost?` and `clockSkewMs?`. Entries with another `version` or another `customType` (for example `"tps"` from other TPS extensions) are ignored.

In `rpc`, `json` and `print` modes pi-tps measures, persists and broadcasts, but never calls `setStatus`.
