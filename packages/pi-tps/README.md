# pi-tps

Generation-speed readout for Pi's footer. pi-tps measures every assistant request of an agent run: time to first token (TTFT), thinking and output, the generation rate in tokens per second (TPS, thinking included), stalls, and burst delivery (a proxy that buffers the response and flushes it at once). A live figure only means something next to what the same model usually does, so while a request streams the readout shows its live TPS and TTFT beside the serving model's smoothed averages, coloured by how the request compares with them; between requests it shows the averages and the run's progress; once Pi has finished a prompt it shows the current model's averages and totals over every run of the session. Streamed tokens are estimated with [tokenx](https://github.com/johannschopplich/tokenx) and calibrated per provider and model against the usage the provider reports, so live figures converge on real token counts. Each run is stored in the session, so the averages and totals survive resume, `/reload` and `/tree`.

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
| command | `/tps` | Show or hide the readout. Measurement, persistence and broadcasts continue while hidden. Takes no arguments. |
| status | `pi-tps` | The readout, written to the footer with `ctx.ui.setStatus` (interactive mode only). |
| session entry | `customType: "pi-tps"` | One record per run; never sent to the model. |
| events | `pi-tps:status`, `pi-tps:telemetry`, `pi-tps:run`, `pi-tps:request` | Event-bus contract for other extensions (below). |

Visibility lasts until the extension runtime is replaced (`/reload`, session switch), which restores `enabled` from the configuration.

## Reading the readout

The readout is one line in Pi's footer, on the status line it shares with other extensions. It follows the **run**: everything Pi does for one prompt, from the moment you send it until Pi stops on its own. That covers every request to the model, every tool call between them, automatic retries and queued follow-ups. While a request is in flight the line compares it with the model's usual figures; when no run is active it shows those usual figures and what the whole session has done so far.

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

1. **Waiting, first request of a model.** A request has been sent and nothing has come back yet; `TTFT` counts up. The model has not served a request on this branch, so there is no average to compare with.
2. **Waiting** for the first token of the run's second request. The live TPS is `-` until the model generates; the averages follow in parentheses.
3. **Streaming.** The model is thinking or answering; the figures are for this request only and update about ten times a second.
4. **Streaming, hidden thinking.** The model thinks without showing its thoughts (for example OpenAI's reasoning models): only the thinking time is known, and `TTFT` keeps counting until the first content arrives.
5. **Working** between two requests, usually while a tool runs: the current model's averages, which already include the request that just ended, then the run's time, its requests so far and their output.
6. **Idle** after three runs: the current model's averages, then totals over every run on the branch.
7. **Idle after an aborted run**: you pressed Escape during the last run; the totals still include it.
8. **Idle with a burst-only model**: every answer of that model arrived in one piece instead of streaming (typically a proxy that buffers responses), so its generation speed cannot be measured and the burst throughput is shown instead.
9. **No data**: nothing has been measured on this branch yet.

### Fields

Fields are separated by ` | ` (see `separator`). Each field appears only when it has a value; the table says in which states. Fields come in order of importance, so when the footer is too narrow Pi cuts the line from the end.

| Field | Shown in | Meaning |
|---|---|---|
| `68.3 (x̄52.3) TPS` | Waiting, streaming | **Generation speed** of the request in flight, then the serving model's average TPS in parentheses (left out while the model has none). The speed counts tokens the model generated per second, thinking included: the thinking and output that arrived in the last 5 seconds divided by the generating time in those 5 seconds. While the model streams its thinking it is instead the thinking tokens so far divided by the thinking time so far, so it does not drop in the silences of a summary. It starts 1.8 s after output starts (1.5 s after thinking starts) and shows `-` before that and while the model thinks without showing its thoughts. Pauses in the output are left out of it, and so is everything that arrives in the first 0.3 s of a phase or after a pause: a backlog the provider generated while you were still waiting, or during the pause, and delivers at once. |
| `x̄52.4 TPS` | Working, idle | **Average TPS** of the current model alone; `- TPS` while it has none. |
| `x̄↯225.0 TPS`, `(x̄↯225.0)` | All | **Burst throughput** average, in place of the TPS average while the model has only burst requests: output tokens divided by the whole time from sending the request to the end, waiting included. It describes delivery, not generation speed. |
| `TTFT 0.6s (x̄1.1s)` | Waiting, streaming | **Time to first token** of the request in flight, then the serving model's average TTFT in parentheses. From sending the request until the first piece of the answer (text, thinking or tool call) arrives; when that piece is thinking and the provider announced the start of the thinking block earlier, until that announcement. It counts up while waiting (also while the model thinks without showing it) and freezes when the first piece arrives. |
| `TTFT x̄1.0s` | Working, idle | **Average TTFT** of the current model; `TTFT -` while it has none. |
| `↓1.2K` | Streaming, working, idle | **Output tokens** the model wrote as answer text and tool-call arguments, without thinking. While streaming it is an estimate for the current request (shown once content has arrived); while working, the total of the run's finished requests; when idle, the total over the session. |
| `⠿1.9K 4.0s` | Streaming, idle | **Thinking**: the number of reasoning tokens, then how long the model has spent thinking in this request (from the start to the end of its thinking blocks, silences included). While the model thinks without showing its thoughts only the time is shown (`⠿4.0s`). The time is left out when it is under 0.05 s. When idle the field is the session's thinking tokens alone (`⠿2.1K`), left out when no provider reported or streamed any. |
| `2➤` | Waiting, streaming, working, idle | **Requests.** While a request is in flight: which request of the run it is, shown from the second on. While working: how many requests the run has made so far. When idle: how many the session has made. Requests that failed with an error do not count. |
| `run 12.3s` | Working | Time since the run started. Keeps counting while tools execute. |
| `3 runs in 4m 12s` | Idle | **Runs** (prompts) on the branch and their summed wall-clock time, tools and waiting included (`1 run in 18.4s` for one). |
| `↑40K ◎88%` | Idle | **Input tokens** sent to the model, added up over every request of the session. Each request re-sends the conversation, so this is what you pay for. Cached tokens are included; `◎` is the share of that input read from the provider's prompt cache, left out when nothing came from the cache. The field is left out when no input was reported. |
| `$0.050` | Idle | **Cost** in US dollars, added up over the session. Shown only when a model has a price in Pi. |

### Markers

| Marker | Meaning |
|---|---|
| `⠋⠙⠹…` | A run is active. Turning animation off shows the first frame without rotating. |
| `✓` | The last run finished normally. |
| `✗` | You stopped the last run with Escape. |
| `x̄` | The figure after it is an average: `x` with a combining macron, the sign of a mean. |
| `↯` | The average after it is a burst throughput, not a generation speed. |
| `-` | Not known: not measured yet, or not measurable (for example a model whose requests were all too short to rate). |

### Averages

The averages belong to one provider and model and cover the requests that model served on the current branch, in order, so they come back after resume, `/reload` and `/tree`. Each average starts as the plain mean of the model's first ten samples and then moves by a tenth of the difference to each new one, so a single slow or fast request barely changes it; see [Measurement](#measurement) for which requests count. The figures in parentheses never include the request in flight.

While a request is in flight the averages are those of the model serving it: the selected model until the provider names the serving model, which behind a virtual model is the physical one. Otherwise they are those of the **current model**: the model you selected, or, when the last request on the branch was sent under that selection, the model that served it (so a virtual model shows the averages of the model behind it). Selecting another model changes the idle readout at once.

### Colours

The live TPS and TTFT are coloured; the `TPS` label after the live number and the `TTFT` label before the live time share its colour. Each metric has one of two modes (`tps.mode`, `ttft.mode`, per model through `overrides`):

- **`relative`** (the default) colours the live value by how it compares with the serving model's average: the TPS as a percentage of the average TPS, the TTFT as the average TTFT as a percentage of the live TTFT, so that a first token faster than usual reads high. By default 75 % or more is the theme's success colour, 40 % or more its warning colour, anything lower its error colour (green, yellow and red in most themes). A model that is slow but as fast as usual is therefore green.
- **`absolute`** colours the value itself: by default TPS is the error colour below 30 tok/s, the warning colour from 30 and the success colour from 80; TTFT is the success colour below 3 s, the warning colour from 3 s and the error colour from 6 s.

Relative mode uses the absolute thresholds for a metric while the model has no average of it (its first request), and for TPS while its only average is a burst throughput. A live `-`, and a live TTFT while a thinking phase without content is open (its time is thinking, not latency), use the base colour. When no run is active nothing is coloured by thresholds: `✓` uses the theme's success colour, `✗` its error colour, `↯` the `burstColor`, separators the `separatorColor`, and everything else, averages included, the `baseColor`.

### Number formats

Token counts below 1000 are exact; larger ones use `K` (thousand), `M` (million) and `B` (billion) with one decimal, dropping `.0` (`1.2K`, `40K`). Durations show one decimal below a minute (`18.4s`), then the two largest units (`1m 30s`, `2h 15m`, `3d 12h`). Speeds always show one decimal. Costs show four decimals below one cent, three below one dollar, then two.

## Measurement

All durations come from a monotonic clock (`performance.now`).

- **Run.** Starts at the first `agent_start` after the previous run settled and ends at `agent_settled`. A run in which no request was measured (for example one that only errored) is not recorded.
- **Request scope.** A request is measured from `before_provider_request` while an agent turn is active to the turn's assistant `message_end`. Cache warming, compaction and branch summaries run outside turns and are ignored, as are model calls that tools make after the assistant message ended. A repeated request before the stream started is taken for a retry and restarts the measurement; a request starting while the stream delivers deltas is ignored.
- **Model identity.** The request starts under the selected model and switches to the model named in the assistant `message_start`: behind a virtual model that is the physical model, whose calibration ratio, averages and colour settings then apply. The record names the serving model and, when the selected model differs, the selected one as `requested`.
- **TTFT**: request start to the first non-empty text, thinking or tool-call delta; when that delta is thinking and its block began with a `thinking_start` event, request start to that event. A thinking block that streams nothing does not end the wait. The time to the first visible text or tool call and the time to response headers are kept in the record.
- **Thinking phases.** A thinking phase opens at `thinking_start` (or at a thinking delta when no start came first) and closes at `thinking_end`, at the next non-thinking event (`text_start`, `toolcall_start`, an output delta) or at the end of the request. The *thinking time* is the summed wall time of the phases, silences included: a model that thinks without streaming its thoughts, or streams a summary in a few chunks, is still thinking. Each record says whether its thinking was `none`, `hidden` (phases without deltas) or `streamed`.
- **Output span.** Output deltas (text and tool-call arguments) have an *active span*: the gaps between consecutive output deltas of one phase. The gap between a thinking phase and the first output delta belongs to neither.
- **Stalls.** A gap of 500 ms or more between two consecutive output deltas is a stall. Consecutive stalled gaps are one stall event. Stall time is excluded from the output span; the gap before the first delta is TTFT, and gaps inside a thinking phase or around a phase change are not stalls.
- **Generation time and rate.** A request's TPS is its *generated tokens* over its *generation time*, when that time is at least 1 s. When a thinking phase was observed, the generation time is the thinking time plus the output span and the generated tokens are `usage.output` (which always includes reasoning); the backlog that opens the answer was generated during the thinking time, so it counts. Without a thinking phase, the output is counted by the live TPS's rules over the whole request: the generation time is the counted output time (the output span without the backlog windows after the first delta and after stalls), and the generated tokens are `usage.output` minus the reported reasoning tokens (whose time is hidden in TTFT and not guessed) times the counted share of the arriving output estimate, so a backlog generated during TTFT does not inflate the rate; both are 0 when no output estimate arrived (for example only whitespace). Without `usage.output` the calibrated estimate is used and the record is marked `estimated`. The record also keeps `outputTps` (visible output over the output span) and `thinkingTps` (thinking tokens over the thinking time). Negative or non-finite usage counts are treated as 0.
- **Thinking tokens.** `usage.reasoning` when it is positive (capped at the output), else, when thinking was streamed, the calibrated thinking estimate. A reported `0` next to streamed thinking means "no breakdown", not "no reasoning": OpenAI-compatible backends such as Ollama and llama.cpp always report 0. Visible output is the output minus the thinking tokens.
- **Live TPS.** The generation rate over the last 5 s. Each delta's calibrated tokens (output and thinking, each kind with its own ratio) are attributed to the interval since the previous delta of the same phase; intervals are clipped to the window and their tokens prorated by the share inside it. The first delta of a phase, intervals across a phase change and output stalls count neither tokens nor time. A delta that starts a phase or ends an output stall also opens a *backlog window* of 300 ms: providers deliver the text generated before that delta (during TTFT, a thinking phase or the stall) over several network reads within about 150 ms, so no time inside the window counts and an interval reaching into it counts only its part after it, with its tokens prorated. The window is fixed at that delta, so a fast stream loses only 300 ms of data. The time since the last delta counts, outside a backlog window, while output flows without a stall. Deltas of one network read (less than 1 ms apart) are one arrival. While a thinking phase that has streamed is open, the figure is the calibrated thinking tokens over the thinking time so far instead (from 1.5 s of thinking time): a summary arrives in chunks seconds apart, which carry the reasoning's volume but not its timing. When the phase closes the window applies again, its thinking intervals included. The figure is unavailable until the window holds 1.5 s of counted time (1.8 s after output starts) and while a thinking phase without deltas is open; after continuous output it survives a pause of up to 3.5 s and returns 1.8 s after output resumes from a longer one.
- **Averages.** Each provider and model has three averages over the settled requests it served on the branch, replayed oldest first: the **TPS** average from the generation rate of each non-burst request with at least 1 s of generation time, the **burst** average from the throughput of each burst request, and the **TTFT** average from every settled request, bursts included (their first token really arrived that late). Only positive samples count: a TTFT rounds to 0 when the first token arrives within 0.5 ms, and an average of 0 could never move again. The first ten samples of an average form their plain mean, so a slow cold start is diluted within a few requests instead of anchoring the figure; from the eleventh on, each sample is clamped to between a third of and three times the current average and folded in with weight 0.1, so the average remembers about the last twenty requests, one outlier moves it by at most +20 % or −6.7 %, and a lasting change still shows within a few dozen requests. Shorter requests, typically tool calls without thinking, have no rate of their own: their reported output includes tool-call framing that is never streamed. Aborted requests feed no average. An average is updated when its request ends, before the next readout, so the working readout already includes it.
- **Session totals.** Summed over every run on the branch, aborted and burst ones included: the runs and their wall-clock time, the requests, input with cache reads and writes, cache reads, visible output (output minus thinking), thinking tokens, and the cost of the requests that carry one.
- **Burst.** Only output deltas are burst evidence: a thinking summary arrives in a few chunks at the provider's cadence. Output deltas less than 1 ms apart arrived in one network read and form one batch. A request is burst delivery when its output stream of at least 50 tokens arrived in fewer than 5 batches (including no deltas at all; shorter replies are just too short to measure), when one 100 ms window carries at least 50 % of its arriving output tokens (estimate corrections excluded) while the output stream (first to last output delta) lasted more than 1 s, or when its generation rate exceeds 10 000 tokens per second. The output stream's token count is `usage.output` minus a positive `usage.reasoning`; `usage.output` alone when no thinking phase was observed and no reasoning was reported; otherwise the calibrated estimate of the output deltas. The 100 ms windows leave out the deltas in the backlog window that opens each output phase (its first output delta and those up to 300 ms after it), while the share is still taken of all arriving output tokens: an answer that starts with the backlog of a thinking phase is not a burst, and a flush after a stall still is. Bursts are excluded from calibration and the TPS average; their throughput feeds the burst average, their TTFT the TTFT average, and their tokens and cost the session totals.
- **Aborted** requests (Escape) keep a partial record. They feed neither calibration nor any average, because they stop at an arbitrary point; their tokens and cost count toward the session totals. **Errored** and **deferred** requests produce no record; the run continues, and the readout shows the working state until the next request, for example Pi's automatic retry.
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

Ratios are stored per `<provider>/<model>` under both the response model the provider reports (`responseModel`) and the model id of the serving model (`model`), so a new request can look its ratios up before the provider names the response model. They are never stored under a selected virtual model (`requested`).

With `"calibration": false` in the [configuration](#configuration) nothing is learned: live counts and the live TPS use the raw estimate (a factor of 1), a request without reported usage records its raw estimate, and the calibration directory is neither read nor written, so none of its warnings appear.

### Limitations

- Estimates are heuristic. Live figures of a model without calibration can be off by tens of percent, most for code and CJK text, until the first calibrating request settles; they carry no marker. Summary lengths do not scale linearly with the reasoning behind them, so the thinking ratio of summary models stays noisy.
- When a provider reports reasoning tokens but shows no thinking phase (for example an OpenAI reasoning model behind a Chat Completions proxy without `reasoning_content`), their time cannot be separated from TTFT: the speed then rests on the visible output, the live readout shows no thinking field, and the tokens count toward the session's `⠿` total.
- Backends that synthesise the start of a thinking block from its first chunk (OpenAI Completions, Google, Mistral, Bedrock; see the table above) hide the thinking before that chunk in TTFT, so the rate of a summary model behind them is an upper bound. The live thinking figure counts that chunk's tokens over almost no time, so it starts high (about 1.3–1.5 times) and settles as thinking continues. Nothing in the stream tells such a start from a real one, so it is not marked.
- A thinking phase with a real network stall is counted as thinking: the two cannot be told apart.
- A proxy that buffers a whole chain of thought and flushes it with a short answer (under 50 visible tokens) is not caught as burst. Such a request has no rate of its own anyway.
- A backlog delivered over more than 300 ms (a slow, high-latency link) partly leaks into the live window and raises the live figure for up to 5 s.
- Without a thinking phase, an answer needs 1.3 s of output span to reach 1 s of counted time, so short answers have no rate of their own; their tokens still count toward the totals.
- The live and settled rates of a request with a thinking phase are not computed alike: the settled rate rests on `usage.output` over the thinking time and the whole output span, backlog included. The settled rate, which feeds the average, is the authoritative one.
- The rate includes thinking. Relative colours compare it with the same model's average, which includes thinking too; absolute thresholds judge summary and hidden-reasoning models by their reasoning rate, so per-model `overrides` may need adjusting. Models with hidden thinking fold the thinking time into TTFT, and so does their TTFT average, so their relative TTFT colour stays comparable within the model.
- Relative colours show how a request compares with the model's usual figures, not whether the model is fast: a slow model at its usual speed is green. Set `mode` to `"absolute"` for a metric, globally or per model, to judge the value itself.
- Averages cover the requests of the current branch only: a model that served requests in other sessions starts without averages in a new one.
- `x̄` is `x` followed by a combining macron (U+0304). pi-tui counts it as one column, so truncation stays correct, but some terminal fonts draw the macron slightly off-centre.
- `↑`, `↓` and `◎` are East Asian ambiguous-width characters. Terminals configured to draw such characters double-wide misalign the footer, because pi-tui counts one column for each.
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
| `calibration` | boolean | `true` | Learn calibration ratios (see [Estimation and calibration](#estimation-and-calibration)). When `false`, live counts use the raw estimate and the calibration directory is neither read nor written |
| `separator` | non-empty string without control characters | `" \| "` | Drawn between fields |
| `baseColor` | colour | `"dim"` | Colour of the spinner, the averages, the labels outside the live figures and every other field |
| `separatorColor` | colour | `"borderMuted"` | Colour of the separator |
| `burstColor` | colour | `"mdLink"` | Colour of the `↯` before a burst throughput |
| `animation.enabled` | boolean | `true` | Rotate the spinner; when `false` the readout redraws only when a value changes |
| `animation.intervalMs` | number from 50 to 1000 | `100` | Refresh interval while a run is active |
| `animation.frames` | non-empty strings without control characters | braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | Spinner frames |
| `tps.mode` | `"relative"` \| `"absolute"` | `"relative"` | How the live TPS is coloured (see [Colours](#colours)) |
| `tps.relative` | threshold list, percent of the model's average TPS | `0→error, 40→warning, 75→success` | Bands of the live TPS in relative mode |
| `tps.absolute` | threshold list, tokens per second | `0→error, 30→warning, 80→success` | Bands of the live TPS in absolute mode, and in relative mode while the model has no TPS average |
| `ttft.mode` | `"relative"` \| `"absolute"` | `"relative"` | How the live TTFT is coloured |
| `ttft.relative` | threshold list, the model's average TTFT as percent of the live TTFT | `0→error, 40→warning, 75→success` | Bands of the live TTFT in relative mode |
| `ttft.absolute` | threshold list, seconds | `0→success, 3→warning, 6→error` | Bands of the live TTFT in absolute mode, and in relative mode while the model has no TTFT average |
| `overrides` | object of `{ "tps"?, "ttft"? }` | `{}` | `tps` and `ttft` settings per provider and model |

A **threshold list** is an array of `{ "min": number, "color": colour }`, in any order. A value takes the colour of the highest `min` not above it (of equal `min`s, the later entry); below the lowest `min`, or with an empty list, it uses `baseColor`. Relative lists are in percent, so that `75` means "at least three quarters of the model's usual figure"; for TTFT the percentage is the average over the live value, so a faster first token than usual reads above 100.

A **colour** is a Pi theme token (`success`, `warning`, `error`, `accent`, `dim`, `muted`, `text`, or any other foreground token of the theme), which follows the active theme, or a hex colour `#rgb` / `#rrggbb`, rendered in truecolor or mapped to the nearest palette colour by Pi.

An **override** maps a match key to an object with optional `tps` and `ttft` nodes of the same shape as the top-level ones (`mode`, `relative`, `absolute`). It applies to the model serving the live request. **Override keys** match case-insensitively:

| Key | Matches |
|---|---|
| `provider/model` | that model of that provider |
| `provider/model-*` | models of that provider matching the glob (`*` matches any run of characters) |
| `model`, `model-*` | that model, or matching models, of any provider (`*/model` is the same) |
| `provider/*` | every model of that provider |
| `*` | every model |

When several keys match, only one override applies: the first level in this order wins, exact `provider/model`, `provider/<glob>`, model-only exact, model-only glob, `provider/*`, `*`. Within one level the pattern with more literal characters wins, then the first in the file. Every `mode`, `relative` and `absolute` that the applied override does not set comes from the top-level `tps` and `ttft`; settings of other matching overrides are never combined with it. Only the first `/` separates provider and model, so `openrouter/anthropic/claude-*` targets OpenRouter's `anthropic/claude-*` models.

**Removed keys.** `labels`, `summaryMode` and the top-level `thresholds` of earlier versions are gone; each produces one "unknown setting" warning and is ignored. An override whose value is a threshold list (the earlier format) produces one warning and is ignored. To keep the earlier colouring of the TPS, move the old `thresholds` list to `tps.absolute` and set `tps.mode` to `"absolute"`; move an old override list `"key": [...]` to `"key": { "tps": { "mode": "absolute", "absolute": [...] } }`.

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

`StatusSnapshot` is one of:

- `{ phase: "waiting" | "streaming", provider, model, request, elapsedMs, ttftMs?, liveTps?, outputTokens, thinkingTokens?, thinkingMs?, thinking, average }` for the request in flight: `provider` and `model` name the serving model, `ttftMs` is absent until content arrived, `thinking` is `none`, `hidden` or `streamed`, and `average` holds the serving model's averages without this request.
- `{ phase: "working", elapsedMs, requests, outputTokens, average }` between two requests of a run, with the current model's averages.
- `{ phase: "idle", average, session? }` when no run is active, with the current model's averages and, when the branch holds runs, `session`: `{ runs, elapsedMs, requests, inputTokens, cacheReadTokens, cacheWriteTokens, visibleOutputTokens, thinkingTokens, cost?, lastAborted }` (`inputTokens` without cache reads and writes, as in the records; `lastAborted` is the last run's outcome).

`average` is `{ tps?, burstTps?, ttftMs? }`, each present once the model has a sample of it.

`RunRecord` (`version: 2`) holds `startedAt`, `elapsedMs`, `aborted` and `requests`. Each `RequestRecord` holds `timestamp`, `provider`, `model` (the serving model), `responseModel?`, `requested?` (`{ provider, model }`, the selected model when it differs from the serving one, as behind a virtual model; absent in records of earlier versions, which read as sent under their serving model), `outcome` (`settled` | `aborted`), `burst`, `burstReason?` (`few-batches` | `cluster` | `rate`), `ttftMs?`, `ttftTextMs?`, `headersMs?`, `elapsedMs`, `outputMs`, `generationMs` (thinking time plus output span; without a thinking phase the counted output time, without backlog windows), `generatedTokens` (the tokens the rate counts; without a thinking phase the counted share of the output, possibly fractional), `tps?` (the generation rate), `outputTps?`, `thinkingTps?`, `throughputTps?`, `thinkingMs?` (thinking time), `thinkingTokens?`, `thinking` (`none` | `hidden` | `streamed`), `estimated` (no reported `usage.output`; streamed thinking without a positive `reasoningTokens` has estimated `thinkingTokens` as well), `inputTokens`, `outputTokens` (including thinking), `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens?`, `deltaCount`, `stallCount`, `stallMs`, `cost?` and `clockSkewMs?`. Entries with another `version` or another `customType` (for example `"tps"` from other TPS extensions) are ignored.

In `rpc`, `json` and `print` modes pi-tps measures, persists and broadcasts, but never calls `setStatus`.

## License

[AGPL-3.0-only](https://github.com/ZeroClover/pi-extensions/blob/master/LICENSE)
