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

## Readout

A **run** is everything Pi does for one prompt: every provider request, tool call, automatic retry and queued continuation, from `agent_start` until Pi settles. The summary appears only once the run has settled; averaging after each request of a multi-request run would only flicker.

The default `text` labels, and the `symbols` style (`"labels": "symbols"`):

```
            text                                                       symbols
waiting     ⠋ TTFT 1.2s                                                 ⠋ ⇥1.2s
streaming   ⠙ TPS 48.6 tok/s · TTFT 1.2s · out 1.2K · think 1.9K 4.0s   ⠙ »48.6/s ⇥1.2s ↓1.2K ✻1.9K 4.0s
working     ⠹ run 12.3s · req 1 · out 1.6K                              ⠹ 12.3s ×1 ↓1.6K
summary     TPS 110.5 tok/s · TTFT 0.7s · 18.4s · in 6.2K (cache 92%)   ✓ »110.5/s ⇥0.7s 18.4s ↑6.2K ↻92% ↓1.4K
              · out 1.4K · think 94 4.1s · stall 1.2s×1 · req 3           ✻94 4.1s ‖1.2s×1 ×3 $0.0018
              · $0.0018
burst only  burst 225.0 tok/s · TTFT 4.0s · 4.0s · in 3.1K · out 900    ✓ ↯225.0/s ⇥4.0s 4.0s ↑3.1K ↓900 ×1
              · req 1
aborted     aborted · TPS 47.0 tok/s · TTFT 0.6s · 5.0s · out 64        ✗ »47.0/s ⇥0.6s 5.0s ↓64 ×1
              · req 1
session     session · TPS 110.0 tok/s · TTFT 0.6s · in 40K · out 6.2K   Σ »110.0/s ⇥0.6s ↑40K ↓6.2K ×3 $0.050
              · runs 3 · $0.050
no data     TPS — · TTFT —                                              · »— ⇥—
```

Each readout is one footer line; the wrapped lines above are for this page only. Fields appear in order of importance, so when the footer is too narrow Pi truncates the least important ones. Waiting and streaming add `req N` from the second request of a run on.

| Text | Symbol | Meaning |
|---|---|---|
| `⠋⠙⠹…` | `⠋⠙⠹…` | A run is active (spinner; static first frame when animation is off) |
| `TPS 48.6 tok/s` | `»48.6/s` | Output tokens per second, coloured by the thresholds. Live: last 5 s. Summary: token-weighted over the run (or session) |
| `burst 225.0 tok/s` | `↯225.0/s` | Only burst deliveries: end-to-end throughput instead of a generation rate, uncoloured |
| `TTFT 1.2s` | `⇥1.2s` | Time to first token; counts up while waiting. Summary: mean over the non-aborted requests |
| `18.4s` | `18.4s` | Run wall time; `run 12.3s` while working |
| `in 6.2K (cache 92%)` | `↑6.2K ↻92%` | Input tokens with cache reads and writes folded in, and the share read from the cache |
| `out 1.4K` | `↓1.4K` | Visible output tokens (thinking not included). Estimated while streaming, reported in summaries |
| `think 94 4.1s` | `✻94 4.1s` | Thinking tokens and active thinking time |
| `stall 1.2s×1` | `‖1.2s×1` | Stall time and number of stalls |
| `req 3` / `runs 3` | `×3` | Requests in the run / runs in the session |
| `$0.0018` | `$0.0018` | Cost in USD, only for models with a price |
| — | `✓` | Completed run |
| `aborted` | `✗` | Run aborted (Escape); figures of the requests observed so far |
| `session` | `Σ` | Session average and totals |
| — | `·` | No run yet in `last` mode |
| `~` | `~` | Before a rate: the model is not calibrated yet, or the figure relies on the token estimate |
| `—` | `—` | Not known (yet) |

Token counts use `K`, `M`, `B` with one decimal (`1.2K`, `40K`). Durations show one decimal below a minute (`18.4s`), then two units (`1m 30s`, `2h 15m`). Symbols are single-cell, non-emoji characters, so the footer keeps its width.

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
