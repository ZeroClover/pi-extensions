# Design

## Context

See proposal.md, "Why", for the symptom and its cause. The relevant current behaviour, all in `src/measurement.ts`:

- `delta()` appends an arrival to the live timeline (`live.at`, `tokens`, `kinds`, `counted`). An arrival is `counted` when it follows an arrival of the same phase and, for output, the gap is under 500 ms; the first arrival of a phase and the first after an output stall are not. `recordArrival()` merges a delta into the previous arrival when it comes less than `BURST_BATCH_GAP_MS` (1 ms) later.
- `windowFigures()` sums, for every counted arrival inside the 5 s window, its interval `(at[i−1], at[i]]` clipped to the window and its tokens prorated by the clipped share. `liveRate()` adds the trailing time since the last delta and requires 1.5 s of counted time.
- `settle()` computes `tps` from `generatedTokens` over `thinkingMs + outputSpanMs`, where `outputSpanMs` is the sum of the counted output gaps. It passes the output deltas (`outputAt`, `outputArrived`) to `classifyBurst()` in `src/burst.ts`, which counts batches and searches the largest 100 ms cluster share over all of them.

What the measurements established (debug extension wrapping `fetch` next to the deltas pi-tps receives; Opus 5.5 over the Anthropic API and over a relay, and an OpenAI Responses model; print mode and TUI):

| Situation | Backlog at the start of an output phase | Live peak / steady |
|---|---|---|
| Ordinary request, every backend | ≈0.8 s of steady output within 100 ms, 2–4 reads | 125 / 77, 78 / 52 |
| After 5.4–5.6 s of hidden or summarised thinking | 62–75 % of the answer within 100 ms; one 14.5 KB read of 96 deltas followed by reads 25 ms and 138 ms later | 831 and 544 / ≈100 |

The backlog never extended beyond 140 ms after the phase's first delta. Within one network read, Pi hands the deltas to extensions over up to 22 ms (each event awaits every extension handler and the TUI update before the next), so the 1 ms merge also splits large reads; across reads the gaps are network timing. Replaying the captured deltas through the rule of D1 gives a flat start (agent-turn answers: old 399 and 384 at 1.5 s, new 82 and 70 at 2.0 s; an ordinary answer: old 71 → 54 decaying, new 56 → 54 flat).

## Goals / Non-Goals

**Goals:**
- One exclusion rule for every point where tokens arrive that were generated in unmeasured time, used by the live window, the settled rate of requests without thinking, and (for phase starts) the cluster criterion.
- A live thinking figure that converges to the settled thinking rate.

**Non-Goals:**
- `outputTps` and `thinkingTps` keep their definitions; they are secondary telemetry and not displayed.
- The few-batches criterion is unchanged. Whether the 107 recorded requests with streamed thinking that it classified as few-batches (likely tool calls delivered in one or two reads) are genuine bursts is a separate question.
- Grouping deltas by event-loop turn instead of the 1 ms gap. D1 makes the live figure independent of how a read is split; batch counting keeps its gap rule.
- No configuration of the window length and no per-provider tuning.

## Decisions

### D1. A fixed backlog window after every uncounted arrival

Every arrival that does not count (the first of a phase, the first after an output stall) is an anchor and opens a backlog window `(anchor, anchor + BACKLOG_WINDOW_MS]`; an arrival lies inside it when it comes at most 300 ms after the anchor. Each arrival stores the end of the window of its anchor as its `floor` (a same-read merge adds tokens to an arrival and leaves its floor alone). In `windowFigures()` an arrival's counted part is `(max(at[i−1], windowStart, floor), at[i]]` and its tokens are prorated by that part's share of the whole interval, exactly as at the window edge today; an arrival at or before its floor contributes nothing, but the scan must continue past it (`continue`, not `break`), since older arrivals of an earlier phase may still count. The trailing time in `liveRate()` counts from `max(lastAt, floor of the last arrival)`, never below 0, while the stall test still compares `now − lastAt` with 500 ms. The window does not move when further arrivals land in it.

Time, not gaps, defines the backlog: inside one read the gaps measure how fast Pi drains the queue, between reads they measure network timing, and neither tells generation from delivery. Anchoring at a fixed point bounds the loss for a genuinely fast stream at 300 ms of data whatever its delta rate; a window that restarted at each arrival would never end for a stream with deltas every 10–20 ms.

Alternatives considered:
- *Consecutive arrivals closer than a gap threshold (e.g. 50 ms) form the backlog.* Fails both ways on the data: the backlog's third read came 113 ms after the second, and Claude's steady cadence is 70–130 ms, so no threshold separates them; a fast model's 10–20 ms cadence would be excluded entirely.
- *Exclude a dense cluster (the burst criterion's idea, online).* Needs a reference rate the window does not have yet at a phase start, and any absolute density threshold depends on the model's speed.
- *Median of interval rates, a longer warm-up, an EMA.* The median changes what the figure means and is biased low by tokenx's integer increments; a longer warm-up does not help because the backlog stays in the 5 s window; an EMA was rejected in the previous design (it hides what the user asked to see).

### D2. `BACKLOG_WINDOW_MS = 300`

In `src/constants.ts`. The measured backlogs ended within 140 ms of their anchor; 300 ms leaves a margin for slower links, where the later reads of a backlog follow at round-trip intervals. The cost is that the live figure appears 1.8 s instead of 1.5 s after a phase opens, and that 300 ms of each phase's output is not counted. `LIVE_MIN_COUNTED_MS` stays 1.5 s.

### D3. Cumulative rate while a streamed thinking phase is open

While a thinking block that has streamed a delta is open, `liveRate()` returns the snapshot's calibrated thinking tokens over its thinking time (both already computed in `snapshot()`), when that time is at least `LIVE_MIN_COUNTED_MS`. A summary arrives in chunks seconds apart: those chunks carry the reasoning's volume but not its timing, so a 5 s window over them swings between the backlog of a chunk and zero. The cumulative figure is the settled `thinkingTps` formula with the calibrated estimate in place of the reported count, so the live figure converges to it; for a model that streams its full chain of thought, cumulative and windowed rates are close anyway.

Thinking arrivals keep entering the live timeline with their own backlog windows. After the phase closes the window rule applies again and the thinking intervals inside the last 5 s count as before, together with the answer's: availability depends on their combined counted time. A full chain-of-thought model whose thinking phase lasted at least about 1.8 s (1.5 s of counted time plus the thinking phase's own backlog window; the answer's backlog window delays nothing while the thinking intervals are still inside the 5 s window) moves from thinking to answer without a gap; after a shorter phase the figure returns as soon as the combined counted time reaches 1.5 s (for thinking from 0 to 1.6 s with a delta every 100 ms, 0.5 s into the answer), and after a summary whose chunks left no interval in the last 5 s it returns 1.8 s into the answer at the latest.

With this rule the window branch never sees an open thinking phase: an open block either has streamed (cumulative figure) or has not (unavailable), and closing a block starts a new phase. The current rule that the trailing time counts while thinking is therefore dropped, together with its branch.

Alternative considered: window over output arrivals only, cumulative thinking rate as a fallback while the output window holds less than 1.5 s. Rejected: one more rule, and short answers after thinking would show the thinking rate throughout.

### D4. Cluster criterion without the phase-opening backlog

`delta()`, which already knows whether an output delta starts its phase, marks every output delta inside the backlog window opened by the first output delta of an output phase (the request's first output delta, or the first after a thinking phase), next to `outputAt` and `outputArrived`. `classifyBurst()` searches the largest 100 ms window over the unmarked deltas only and divides it by the total of all arriving output tokens, marked ones included. Batch counting and the span check (first to last output delta) still use all output deltas, so the few-batches criterion and a whole response flushed in a few reads are unaffected.

Keeping the total whole makes the change one-sided: a window's share can only shrink, so no request becomes a cluster burst that was not one before. Shrinking the total as well would turn sparse streams into bursts: for two short output phases with 10 tokens at 0, 100, 200, 300 and 400 ms each, the largest window drops from 20 % to 10 % of the total, whereas leaving their first 300 ms out of the total too would raise it to 50 % and mark a normal request as burst.

Backlog windows opened after a stall are not excluded here: "streams normally, falls silent, flushes the rest" is exactly what the cluster criterion exists for (`Proxy flush after a long wait`). What this gives up: a proxy that flushes a large head at the start and then streams normally is no longer a cluster burst; it is still caught when the whole response arrives in fewer than 5 batches, and its live and settled rates are now protected by D1 and D5 instead.

Alternative considered: raise `BURST_CLUSTER_SHARE`. Rejected: the misclassified streams carry 62–75 %, the same range a real tail flush has.

### D5. Settled rate of requests without a thinking phase

When no thinking phase was observed, `settle()` computes the counted output over the whole request with the same timeline and rules as the live window: `windowFigures()` with no window start and factor 1 (without a thinking phase the timeline holds output arrivals only). With `arrived` the sum of the positive output arrivals' raw estimates and `counted` the prorated raw tokens it returns: `generatedTokens = (usage.output − reasoning) × counted / arrived` (the calibrated estimate in place of `usage.output` when that is missing), `generationMs = counted time`, `tps` as before from these two, with the 1 s minimum. When `arrived` is 0 (no output delta, or only deltas whose estimate adds nothing, such as whitespace), `generatedTokens` and `generationMs` are 0 explicitly rather than `0/0`, and there is no rate; a `NaN` would make the record parser reject the whole run.

The share is taken from the estimate and applied to the reported count, which keeps `usage.output` authoritative for the volume while the estimate only says which part arrived when. Stall-opened windows are excluded here too: tokens flushed after a stall were generated during it, and the stall's time is not in the output span. With a thinking phase nothing changes: the backlog of the following output was generated during the thinking time, which is in the denominator, so excluding its tokens would bias the rate low.

`generatedTokens` can become fractional; the record parser accepts any non-negative number. The record version stays 2: the fields keep their meaning (the tokens and time the rate counts), only their value for requests without thinking becomes more accurate.

Alternative considered: correct only the first chunk. Rejected: the backlog spans several reads (Context).

## Risks / Trade-offs

- [A backlog spread over more than 300 ms, on a high-latency link, leaks into the live window] → The leak is bounded by what arrives after 300 ms and leaves the window after 5 s; the constant can be raised, and the debug extension used for this change measures it.
- [Short answers without thinking lose their settled rate] → A stream of 1.0–1.3 s now counts less than 1 s. These are exactly the requests whose rate was the most inflated (≈80 % at 1 s); their tokens still count toward the totals.
- [The model's average moves] → For models answering without thinking, new requests settle lower than before; the moving average follows within about 20 requests. Old records are not rewritten.
- [The figure changes source when a thinking phase closes] → The cumulative thinking figure hands over to the window; for full chain-of-thought models the window's thinking intervals bridge it, for summary models the readout shows `-` for up to 1.8 s and then the answer's rate (D3).
- [Backends that synthesise `thinking_start` from the first chunk] → The thinking time starts at that chunk, whose tokens then count over almost no time: the cumulative figure starts about 1.3–1.5 times high at 1.5–2 s and settles as thinking continues. It is an upper bound, as the settled one already is; the README's limitation on such backends mentions the live figure too.

## Migration Plan

None beyond the release: no schema, configuration or file format changes. Release intent `minor` (`@zeroclover/pi-tps`): live and settled figures change for every user.
