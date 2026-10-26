# Design

## Context

See proposal.md, "Why". The facts below shape the design. They were verified against Pi 1.4.0 under `node_modules/@earendil-works/`, by diffing the 1.3.0 copies still in the pnpm store, and by live checks of each adapter's `streamSimple` against a local HTTP server that answers 429 and 503.

- **Bedrock delivers error headers, once per AWS SDK attempt.** `bedrock-converse-stream.js` installs `addResponseHeadersMiddleware` at the deserialize step, and it reports every raw HTTP response, error responses included. Pi 1.3 had the same middleware.
  - The AWS SDK's default `maxAttempts` is 3. Pi never sets it, so `retry.provider.maxRetries: 0` does not stop those retries.
  - Live: one Pi request against a 429 server fired `onResponse` three times (`[429, 429, 429]`). A throttle that recovers gives `[429, 200]`.
  - Today the gate is open for Bedrock. `HeaderCapture.requestEnd` sees more than one capture and sets `closedReason`, which turns header hints off for the session on every adapter.
- **Codex repeats a request over HTTP (SSE) only when `retry.provider.maxRetries` is above 0.** Its WebSocket reconnects (missing continuation, connection limit, `openai-codex-responses.js:223-229`) ignore that setting, but they report no response event.
  - `openai-codex-responses.js` sets `DEFAULT_MAX_RETRIES = 0`. Its SSE fetch loop runs `attempt <= options.maxRetries`, and `sdk.js` fills `options.maxRetries` from `retry.provider.maxRetries`.
  - The WebSocket path never calls `onResponse`. Line 286, in the SSE loop, is the only call site.
  - With the default `auto` transport, a WebSocket attempt that fails before its message stream starts falls back to that SSE loop within the same request (`openai-codex-responses.js:242-248`), and the rest of the session then uses SSE. With provider retries off, such a request still yields one response.
  - Live: no provider retries gave `[429]`. `maxRetries: 1` gave `[503, 503]`, a case the existing `providerMaxRetries` condition already closes.
- **The six Pi 1.4 additions to the retryable list** are `upstream.?request.?failed`, `upstream_stream_read_error`, `stream was interrupted`, `http/?2 stream failed`, `request to \S+ failed, reason:` and `stream disconnected before completion`. Pi 1.4 also adds the non-retryable `subscription_sharing_workplace_individual_usage_limit_exceeded` and the bounded status rule (#11057).
  - pi-retry already treats that non-retryable code as `quota` through `usage.?limit`.
  - The six additions match no rule and end up as `unknown`.
  - The texts behind each addition are in Pi's comments (#10920, #10996, #11057), and every one of them was run through `classify`.
- **Deterministic groups are tested in this order:** overflow, auth, not_found, content_policy, invalid_request, quota. The first match wins. Anthropic's low-credit error carries `invalid_request_error` and `Billing`, so today it stops at `invalid_request`.
- **The e2e scripted provider names a single API** (`"scripted"`) on every message. The failed message's `api` is what the gate's adapter rule reads, so a Bedrock or Codex failure cannot be scripted today. Each scripted `Response` already carries per-message overrides (`model`, `responseModel`, `diagnostics`), but it reports exactly one `onResponse` per request, so an adapter's internal retries cannot be scripted either.

## Goals / Non-Goals

**Goals:**
- Every Pi-behavior statement in the README, specs and source notes is true for Pi 1.4, and names that release where it states a version.
- The gate excludes exactly the adapters whose request can yield several response events whatever Pi's settings say.

**Non-Goals:**
- Changing which failures are retried, apart from these documented effects:
  - Codex requests served over SSE gain header hints.
  - A quota-worded invalid request with an accepted hint is now retried.
  - Pi's Codex usage-limit message without a reset time, or with `Try again in ~0 min.`, is now retried with backoff (D7).
  - A Bedrock failure that the AWS SDK does not retry loses the header hint it gets today. The SDK retries only throttles (every 429) and transient failures, which include HTTP 500, 502, 503 and 504. Its standard strategy accepts only the `THROTTLING` and `TRANSIENT` error types (`@smithy/core` retry `index.js:524-525`, and `defaultRetryDecider` at `:609-614`), so those failures still yield several captures. Other statuses yield a single capture unless a retryable trait applies, and their header hint is lost. Examples are a 408 `ModelTimeoutException`, a 409, or a 501. Such a failure falls back to text, diagnostics, or backoff. This is the price of the simplest fix: these cases are rare, and Bedrock throttles and transient 5xx errors (500/502/503/504) already yield several captures.
- Tracking Pi's lists automatically, for example by calling `isRetryableAssistantError` at runtime. pi-retry's policy deliberately differs (see the examples in the spec scenario "Pi's lists are covered with documented differences"), and Pi's list is a boolean without a category or reason.

## Decisions

### D1. Exclude Bedrock by API; keep the window rule as the safety net

`MULTI_RESPONSE_API` becomes `bedrock-converse-stream`, and the existing reason format (`<api> retries inside one request`) stays. `gateFor` closes for Bedrock before `requestEnd` counts captures, so Bedrock failures never set `closedReason`.

Alternatives considered:
- **Use the last capture of a Bedrock window.** In `[429, 200]` followed by a mid-stream failure, the 429 does not belong to the failure. Choosing between captures would also break the gate's one-request, one-response invariant.
- **Set the SDK's `maxAttempts`.** It belongs to pi-ai's client and is out of an extension's reach.

Bedrock still gets hints from text and diagnostics, as it does today.

### D2. Drop the Codex exclusion instead of re-labelling it

The condition repeats `providerMaxRetries == 0`, and it suppresses valid single-response hints on Codex over SSE. If the assumption ever breaks, the window rule still sees a second capture and closes the gate, so dropping the exclusion cannot make attribution wrong; at worst the gate closes.

Alternative considered: keep the exclusion and only fix its wording. Rejected because it would leave a dead rule in the code and in the README.

### D3. New vocabulary rows and their categories

| Wording | Category | Why |
|---|---|---|
| `stream disconnected before completion` | `transport` | Codex CLI mid-stream disconnect relayed by proxies (#11057) |
| `stream was interrupted` | `transport` | gateway stream interruption (#10920) |
| `http/?2 stream failed` | `transport` | gateway stream interruption (#10920) |
| `request to \S+ failed, reason:` | `transport` | node-fetch system error, e.g. the google-vertex ADC token refresh, where the reason is often empty (#10996) |
| `upstream.?request.?failed` | `server_error` | gateway upstream failure, relayed as a Responses `response.failed` code (#10920) |
| `upstream_stream_read_error` | `server_error` | gateway upstream failure, relayed as a Responses `response.failed` code (#10920) |

- The four transport rows join the transport group.
- The two gateway codes extend the existing `provider returned error | unable to forward upstream` server-error row, which has the same source.
- None of the samples matches an earlier rule, so the order inside `TRANSIENT_RULES` stays as it is.

### D4. Quota wording before invalid-request wording

The quota group moves ahead of the invalid_request group in `DETERMINISTIC_RULES`.

Alternative considered: a dedicated `credit balance is too low` row. Rejected because every quota phrase (`billing`, `usage limit`, `insufficient_quota`, …) has the same problem next to an `invalid_request_error` type.

The decision only changes when a hint is accepted, because `invalid_request` and hint-less `quota` both stop. In that case retrying is correct: the provider has stated when the limit resets.

### D5. `api` and earlier responses on a scripted response

`tools/e2e/src/provider.ts` gains two optional fields on `Response`:

- `api`: the adapter the message names, which defaults to the requested model's API, exactly like `model`. The `Streamer` uses `response.api ?? requested.api`.
- `priorResponses`: a list of `{ status, headers }` that `onResponse` reports, in order, before the response's own `status` and `headers`. This is how an adapter's internal retries appear to Pi, for example the AWS SDK's attempts.

`failure()` accepts and forwards both fields. Its options are written out field by field rather than spread, unlike `reply()`, so without this change the new fields would be dropped.

Alternative considered: a package-local provider fixture. Rejected because it would duplicate the scripted provider.

- It is generic machinery: any package that adapts to adapter-specific behavior can use it.
- It changes no existing behavior, so it needs no root OpenSpec change. AGENTS.md rule 1 allows root tooling changes for repo-wide concerns, and the shared harness is where `docs/conventions.md` puts generic test machinery.
- `/retry` reads `ctx.model.api` (the selected model), which this override does not change. The `/retry` reason string for Bedrock is therefore not end-to-end tested. It reuses the existing format.

### D6. Tests

Each test is seen to fail against the current code before the fix, following `docs/conventions.md`.

- `test/hints.test.ts`:
  - A Bedrock failure whose request reports two 429 responses with `retry-after: 1`, the reported bug, uses backoff. A following failure on the scripted adapter with one 429 and `retry-after: 1` then still uses the 1 s header. Before the fix the first failure closes the gate for the session, so the second one falls back to backoff.
  - A Codex failure with one 429 and `retry-after: 1` uses the 1 s header. Before the fix it uses backoff.
- `test/classification.test.ts`: one row per new wording and one for Anthropic's low-credit text. The new rows fail before the fix through their category, not their decision.

### D7. Codex usage limit without a reset time is a rate limit

The owner decided that a Codex 429 without a reset time is retried with exponential backoff.

- **The message is identifiable.** Pi's Codex adapter (`openai-codex-responses.js:1250-1262`) parses the body as JSON. When it has an `error` object and the status is 429, or the code is `usage_limit_reached`, `usage_not_included` or `rate_limit_exceeded`, the adapter replaces the text with `You have hit your ChatGPT usage limit[ (<plan> plan)].`. It appends ` Try again in ~N min.` only when the body has `resets_at`. The error is thrown as a plain `Error` (`:305`), so `formatProviderError` passes the text through unchanged (`utils/error-body.js:111-115`), and no status appears in the text.
- **Diagnostics can be present.** On the default `auto` transport, a WebSocket failure before the stream starts attaches a `provider_transport_failure` diagnostic, carrying the thrown error's `code`, before falling back to SSE (`:234-246`, `utils/diagnostics.js:8-21`). pi-retry joins diagnostic codes to the text with newlines before matching its vocabulary (`src/classify.ts:168`), which would break a `$` anchor. The rule is therefore matched against `message.errorMessage` alone.
- **The rule.** One `rate_limit` rule, anchored to the whole error message (`^You have hit your ChatGPT usage limit(?: \([^)]*\))?\.(?: Try again in ~0 min\.)?$`).
  - It is exported from `src/vocabulary.ts` on its own, not added to `DETERMINISTIC_RULES`. That table is typed to deterministic categories, and `isDeterministic` derives the stopping categories from it, so a `rate_limit` entry there would stop every rate limit.
  - `categorise` in `src/classify.ts` checks it against `message.errorMessage` after the overflow check and before `DETERMINISTIC_RULES`. Today the generic `usage.?limit` quota rule would win.
  - The rule only chooses the category. User patterns, hint extraction, and the acceptance limit in `classify` run unchanged, so an attributable `retry-after` on Codex over SSE still sets the delay.
  - The spec's precedence requirement names this as its one transient-over-deterministic exception. `~0 min` is included on the owner's decision. Pi writes it when the reset is under 30 s away or already past (`Math.max(0, Math.round(…))` of the minutes), so it carries no usable wait. The default backoff's cumulative wait passes 30 s by the fifth retry at the latest (at least 46.5 s with the lowest jitter), so no minimum-wait setting is needed. A message with `Try again in ~N min.` for N ≥ 1 does not match the rule, so it stays `quota` with its hint.
- **Alternatives considered.**
  - Gating on `message.api === "openai-codex-responses"`: rejected, because the anchored whole-message match is already unique to Pi's adapter and needs no second input.
  - Loosening the `usage.?limit` quota rule: rejected, because it would also change real usage limits from other providers.

## Risks / Trade-offs

- [A future Pi adapter retries inside one request] → The window rule closes the gate on the first multi-capture request, which is safe but session-wide. The README names the excluded adapter, so a reader can report a new one.
- [A Codex message without a reset time is a real, lasting limit, for example `usage_not_included` (the plan does not include Codex) or a usage limit whose body lacks `resets_at`] → pi-retry retries it up to `maxRetries` times with backoff before giving up. With the defaults that is 10 retries over about 4.5–6 minutes, after which it reports `giving up after 10 retries`. The owner accepted this cost so that transient Codex 429s are retried; `/retry off` or `/retry cancel` stops it at once.
- [Some invalid request mentions billing or a usage limit] → It is classified `quota` and still stops unless the text also carries a reset hint.
- [Codex header hints depend on the transport] → A request served over WebSocket reports no response and gains nothing. A request served over SSE gains a header hint. That covers the `sse` setting and also the default `auto` transport after a WebSocket fallback. It is still one response per request, so attribution stays correct. The README states this.

## Open Questions

Each of these would change behavior and is left out of this change. Each can become its own proposal.

1. **Wider status positions.** Pi 1.4 reads a status from `Error 503` or `responded with 503`, and pi-retry does not. The decision already agrees (`unknown` is retried), so only the category and reason would gain.
2. **`cacheWarming` scope.**
   - `pi.getSettings()` merges project settings, but Pi reads `cacheWarming` from global settings only. A project-level value can therefore misreport the gate until the first warming decision. `SettingsManager.getCacheWarmingMode()` would read the value Pi uses.
   - `cache_warming_decision` also fires for decisions that end in `stop`, so the gate closes even when no warming request runs. That errs on the safe side.
