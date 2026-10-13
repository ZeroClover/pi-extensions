# pi-tps

Live generation-speed readout for Pi's footer. pi-tps measures every assistant request of an agent turn: time to first token, thinking and output phases, live and settled tokens per second, stalls, and burst delivery (a proxy that buffers the response and flushes it at once). Streamed tokens are estimated with [tokenx](https://github.com/johannschopplich/tokenx) and calibrated per provider and model against the usage the provider reports, so the live figure converges on real token counts. Each request is stored in the session, so the last readout and the session averages survive resume, `/reload` and `/tree`.

## Install

```bash
pi -e ./packages/pi-tps                       # try for one session
pi install /absolute/path/to/packages/pi-tps  # install for the user
```

## Provides

| Kind | Name | Description |
|---|---|---|
| command | `/tps` | Show or hide the readout for this session. Measurement, persistence and broadcasts continue while hidden. |
| command | `/tps mode` | Switch the idle readout between the last request and the session average. |
| command | `/tps mode last` / `/tps mode session` | Set the idle readout explicitly. |
| status | `pi-tps` | The readout, written to the footer with `ctx.ui.setStatus` (interactive mode only). |
| session entry | `customType: "pi-tps"` | One telemetry record per measured request; never sent to the model. |
| events | `pi-tps:status`, `pi-tps:telemetry`, `pi-tps:request` | Event-bus contract for other extensions (below). |

Visibility and mode last for the session; `enabled` and `summaryMode` in the configuration set their initial values.

## Readout

```
waiting    ⠋ τ1.2s Δ–
streaming  ⠙ τ1.2s Δ48.6~ ↓1.2k~ ∴↓1.9k~ 4.0s
settled    ✓ τ0.6s Δ110.5 ↑2.9k↻ ↓388 4.0s $0.0005 ∴↓20 0.1s
burst      ✓ τ4.0s ↯225.0 ↑3.1k ↓900 4.0s
aborted    ✗ τ0.6s Δ– ↑0 ↓64 1.0s
session    Σ τ0.6s Δ110.0 ↑6.2k↻ ↓1.4k $0.0018 ×3
no data    · τ– Δ–        (last mode)     Σ τ– Δ–   (session mode)
```

Fields appear in order of importance, so when the footer is too narrow Pi truncates the least important ones.

| Glyph | Meaning |
|---|---|
| `⠋⠙⠹…` | Request in flight (spinner; static first frame when animation is off) |
| `✓` | Last request settled |
| `✗` | Last request aborted (partial figures) |
| `Σ` | Session averages and totals |
| `·` | No request yet in `last` mode |
| `τ` | Time to first token, seconds. Counts up while waiting |
| `Δ` | Output tokens per second. Live: last 5 s window. Settled: from provider usage over the active output span. Coloured by the thresholds |
| `↯` | Burst delivery: end-to-end throughput (output tokens / elapsed) instead of a generation rate, uncoloured |
| `~` | Estimate not calibrated yet (live), or settled rate that relies on the estimate (no usage, or thinking estimated) |
| `↑` | Input tokens, cache reads and writes included |
| `↻` | Part of the input was read from or written to the prompt cache |
| `↓` | Output tokens (estimated while streaming, reported when settled; includes reasoning) |
| `∴` | Thinking: `∴↓` thinking tokens, `∴Δ` thinking tokens per second, followed by the thinking duration |
| `×` | Number of requests in the session average |
| `–` | Not known (yet) |
| `$` | Cost in USD, only for models with a price |

Durations show one decimal below a minute (`18.4s`), then `1m05s` and `1h02m`. Token counts of 1000 or more use `k` and `M` with one decimal.

## Measurement

All durations come from a monotonic clock (`performance.now`).

- **Scope.** A measurement starts at `before_provider_request` while an agent turn is active and ends at the turn's assistant `message_end`. Cache warming, compaction and branch summaries run outside turns and are ignored, as are model calls that tools make after the assistant message ended. A repeated request before the stream started (a retry) restarts the measurement.
- **TTFT** (`τ`): request start to the first non-empty text, thinking or tool-call delta. The time to the first visible text or tool call and the time to response headers are kept in the record.
- **Phases.** Thinking deltas and output deltas (text and tool-call arguments) are counted separately. Their *active spans* add up the gaps between consecutive deltas of the same kind; the gap where thinking turns into output belongs to neither.
- **Stalls.** A gap of 500 ms or more between deltas is a stall. Consecutive stalled gaps are one stall event. Stall time is excluded from the active spans; the gap before the first delta is TTFT, not a stall.
- **Live TPS.** Calibrated estimated output tokens in the last 5 s, divided by the smaller of 5 s and the time since the first output delta. Unavailable for the first 1.5 s.
- **Settled TPS.** `(usage.output − thinking tokens) / active output span`. Thinking tokens are `usage.reasoning` when the provider reports it, else the calibrated thinking estimate (capped at `usage.output`). When `usage.output` is missing the calibrated estimate is used. A request with less than 1 s of active output span has no settled TPS; the last-request readout then keeps showing the previous settled TPS.
- **Thinking TPS.** Thinking tokens over the active thinking span, when that span is at least 1 s.
- **Burst.** Deltas less than 1 ms apart arrived in one network read and form one batch. A request is burst delivery when it arrived in fewer than 5 batches, when one 100 ms window carries at least 50 % of its estimated tokens while the stream (first to last delta) lasted more than 1 s, or when a computed rate exceeds 10 000 tokens per second. Bursts report throughput (`↯`), count toward session tokens and cost, and are excluded from calibration and average TPS.
- **Aborted** requests (Escape) keep a partial record marked `✗`, excluded from calibration and averages. **Errored** and **deferred** requests produce no record; the previous readout stays.
- **Cost** is taken from `usage.cost.total` only when it is greater than zero.

### Calibration

Each delta is estimated once with tokenx, together with the last 64 characters of the same stream, so words split across deltas are not double-counted. After every settled, non-burst request with reported usage and a raw estimate above 50 tokens, the ratio `reported / estimated` is folded into an exponential moving average (α = 0.3, first sample taken as is, clamped to 0.25–4). With a reasoning breakdown the sample compares visible output only (`usage.output − usage.reasoning` against the output estimate), because streamed thinking is often a summary. Ratios are stored per `<provider>/<model>` under both the response model and the requested model, so a new request can look its ratio up before the provider names the response model.

### Limitations

- Estimates are heuristic. Uncalibrated figures (`~`) can be off by tens of percent, most for code and CJK text, until the first calibrating request settles.
- Providers that hide or encrypt thinking stream no thinking deltas: TTFT then includes the hidden thinking, and thinking TPS is unavailable (the record has `thinkingObserved: false`).
- Providers that deliver text in chunks separated by 500 ms or more (observed with some proxies) have a short active output span, so their requests often have no settled TPS.
- A model call that another extension makes between the turn's provider request and the start of its stream is taken for a retry and restarts the measurement.
- Navigating `/tree` to an assistant message places the leaf before that message's own record, so the readout reflects the requests before it.

## Configuration

Read from `~/.pi/agent/pi-tps.json` (Pi's agent directory, `getAgentDir()`) at session start; run `/reload` after editing. A missing file means defaults. Invalid JSON or an invalid field produces one warning per problem and falls back to the default for that field only; a bad configuration never disables the readout.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Initial visibility of the readout |
| `persist` | boolean | `true` | Append a `pi-tps` entry per request. When `false`, history lives in memory and starts empty at every session start |
| `summaryMode` | `"last"` \| `"session"` | `"last"` | Initial idle readout |
| `baseColor` | colour | `"dim"` | Colour of every field except the output TPS |
| `animation.enabled` | boolean | `true` | Rotate the spinner; when `false` the readout redraws only when a value changes |
| `animation.intervalMs` | number ≥ 50 | `100` | Refresh interval while a request is in flight |
| `animation.frames` | non-empty string array | braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | Spinner frames |
| `thresholds` | threshold list | `0→error, 30→warning, 80→success` | Colour of the output TPS |
| `overrides` | object of threshold lists | `{}` | Thresholds per provider and model |

A **threshold list** is an array of `{ "min": number, "color": colour }`, in any order. The TPS uses the colour of the highest `min` not above it; below the lowest `min` it uses `baseColor`.

A **colour** is a Pi theme token (`success`, `warning`, `error`, `accent`, `dim`, `muted`, `text`, or any other foreground token of the theme), which follows the active theme, or a hex colour `#rgb` / `#rrggbb`, rendered in truecolor or mapped to the nearest palette colour by Pi.

**Override keys** match case-insensitively:

| Key | Matches |
|---|---|
| `provider/model` | that model of that provider |
| `provider/model-*` | models of that provider matching the glob (`*` matches any run of characters) |
| `model`, `model-*` | that model, or matching models, of any provider (`*/model` is the same) |
| `provider/*` | every model of that provider |
| `*` | every model |

When several keys match, the first level in this order wins: exact `provider/model`, `provider/<glob>`, model-only exact, model-only glob, `provider/*`, `*`, then the global `thresholds`. Within one level the pattern with more literal characters wins. Only the first `/` separates provider and model, so `openrouter/anthropic/claude-*` targets OpenRouter's `anthropic/claude-*` models.

<!-- example-config: test/config.test.ts loads this block and expects no warnings -->
```json
{
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
| `~/.pi/agent/pi-tps-calibration.json` | after each calibrating request | `{ "version": 1, "models": { "<provider>/<model>": { "ratio", "samples", "updatedAt" } } }`. Merged with concurrent sessions and replaced atomically. A corrupt file is treated as empty with one warning; an unwritable one warns once per session |
| session file | after each settled or aborted request | `custom` entry, `customType: "pi-tps"`, data: the telemetry record (about 0.5 KB) |

## Event bus

Other extensions can subscribe with `pi.events.on(channel, handler)`. Types are exported from `src/telemetry.ts`.

| Channel | Direction | Payload |
|---|---|---|
| `pi-tps:status` | emitted | `StatusSnapshot` on every state change and every tick while a request is in flight; `null` when the session shuts down |
| `pi-tps:telemetry` | emitted | `TelemetryRecord` of each settled or aborted request, identical to the persisted entry |
| `pi-tps:request` | listened | Any emit makes pi-tps re-emit the current snapshot on `pi-tps:status` |

`StatusSnapshot` is one of `{ phase: "waiting" | "streaming", provider, model, elapsedMs, ttftMs?, liveTps?, outputTokens, thinkingTokens?, thinkingMs?, calibrated }`, `{ phase: "last", record, fallbackTps? }`, `{ phase: "session", aggregate }` or `{ phase: "empty", mode }`.

`TelemetryRecord` (`version: 1`) holds `timestamp`, `provider`, `model`, `responseModel?`, `outcome` (`settled` | `aborted`), `burst`, `burstReason?` (`few-batches` | `cluster` | `rate`), `ttftMs?`, `ttftTextMs?`, `headersMs?`, `elapsedMs`, `outputTps?`, `thinkingTps?`, `throughputTps?`, `thinkingMs?`, `thinkingTokens?`, `thinkingObserved`, `estimated`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens?`, `deltaCount`, `stallCount`, `stallMs`, `cost?` and `clockSkewMs?`. Records with another `version` or another `customType` (for example `"tps"` from other TPS extensions) are ignored.

In `rpc`, `json` and `print` modes pi-tps measures, persists and broadcasts, but never calls `setStatus`.
