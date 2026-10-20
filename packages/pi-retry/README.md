# pi-retry

Automatic retry for failed model requests in Pi. Pi's built-in retry decides with one regular expression over the error text, waits at most 60 s and never reads the wait a provider asks for, so a 429 that says "try again in 90 s" fails after three quick retries, and an error whose wording Pi does not know is never retried. pi-retry steps in once Pi has given up on a failure: it classifies the error into a category (rate limit, overload, timeout, transport, quota, auth, invalid request, …), stops at once on deterministic failures, honours the wait a provider requests (from headers, diagnostics or the error text) up to a configurable limit, and otherwise backs off exponentially with jitter. The retried request runs on the same context with the failed attempt hidden from the model and kept in the session file, as Pi's own retry does. It works in interactive, RPC, JSON and print modes.

## Install

Releases are published to npm as `@zeroclover/pi-retry`, versioned independently of the other packages in this repository. Each release is tagged `@zeroclover/pi-retry@<version>` and its notes are the matching section of the package's `CHANGELOG.md`.

```bash
pi install npm:@zeroclover/pi-retry             # install a published version for the user
pi -e ./packages/pi-retry                       # try a repository checkout for one session
pi install /absolute/path/to/packages/pi-retry  # install a repository checkout for the user
```

**Turn off Pi's built-in retry.** pi-retry acts only after Pi's own retry has declined a failure or used up its budget, and Pi renews that budget before every pi-retry continuation. With both enabled, Pi's fixed delays run before each of pi-retry's waits and the attempts multiply: with the defaults (Pi: 3 retries, pi-retry: 10) up to 44 requests are made, 11 governed by pi-retry and each followed by up to 3 of Pi's. Disabling Pi's retry is required for pi-retry's classification and timing to govern every attempt; add this to Pi's `settings.json`:

```jsonc
{ "retry": { "enabled": false } }
```

While Pi's retry is enabled, pi-retry says so once per session. It never changes Pi's settings.

## Provides

| Kind | Name | Description |
|---|---|---|
| command | `/retry` | Show the effective configuration, the header-hint state and the current state (`idle`, or `waiting` with the attempt, the remaining seconds and the reason). |
| command | `/retry cancel` | End the wait in progress without retrying, and abort the run. |
| command | `/retry off` / `/retry on` | Stop or resume retrying for this session; `off` also cancels a wait. Lasts until the extension runtime is replaced (`/reload`, session switch), which restores `enabled` from the configuration. |
| status | `pi-retry` | `retry 2/10 in 30s`, counting down every second during a wait and cleared when it ends. |
| session entry | `customType: "pi-retry"` | One record per retry (below); never sent to the model. |

Any other argument to `/retry` prints the usage.

## How a failure is handled

1. A request ends with an error. Pi's own retry and overflow compaction run first. When Pi settles on the failure, pi-retry takes it, unless another extension already asked to continue or drafted a compaction.
2. The failure is classified (categories below). A non-retryable failure is reported with `pi-retry: not retrying: <reason>` and left as the last message.
3. If the attempt budget (`maxRetries`) is used up, pi-retry reports `pi-retry: giving up after <max> retries: <reason>`.
4. Otherwise it waits: the provider's requested wait plus 250 ms when there is an accepted hint, or `min(baseDelayMs × 2^(attempt−1), maxBackoffMs)` times a random factor between 0.75 and 1.0. It reports `pi-retry: <category> (<reason>); retry <attempt>/<max> in <duration>`.
5. After the wait it hides the failed message from model context (a `context_edit` entry; the message stays in the session file), records the attempt and re-sends the request. If the retried request succeeds, it reports `pi-retry: succeeded on retry <attempt>`.

The attempt count starts again after a successful response, after an aborted response or run, and when you send a new prompt.

### Ending a wait

| You do | Result |
|---|---|
| Press Escape (interactive mode) | The wait ends at once; no retry is sent and nothing is appended. Reports `pi-retry: retry cancelled`. |
| `/retry cancel` or `/retry off` | Same as Escape, from any mode that runs commands. |
| Type a message during a backoff wait | The wait ends within a second and the retry is sent together with your message. |
| Type a message during a wait the provider asked for | The countdown continues; your message is sent with the retry at the provider's deadline, because sending earlier would ignore the wait the provider asked for. Cancel first to drop the retry. |
| Switch, start or fork a session | The wait ends before Pi replaces the session, so the switch is not delayed; no retry is sent. |
| Shutdown (or a programmatic reload) | The wait ends at once; no retry is sent. |
| Abort from an RPC client | pi-retry cannot observe this abort, so the wait runs to its end; Pi then discards the retry. The empty failed message is hidden and the `pi-retry` record is followed by one with `outcome: "cancelled"`. Use `/retry cancel` to end the wait itself. |

Every cancel also aborts the run, so a queued message does not trigger a request before the provider's deadline; Pi then applies its usual abort handling to queued messages. The built-in `/reload` is refused while the session is busy, which includes a wait: cancel first, then reload.

## Error categories

| Category | Retried | Examples |
|---|---|---|
| `rate_limit` | yes | HTTP 409/429, `rate_limit_error`, `rate_limit_exceeded`, `Too many requests`, `ThrottlingException`, `RESOURCE_EXHAUSTED`, Google's per-minute `Quota exceeded for quota metric …`, LiteLLM `No healthy deployment available` |
| `overloaded` | yes | HTTP 529, `overloaded_error`, `The model is overloaded`, `model is at capacity`, `server_busy`, `high demand` |
| `server_error` | yes | other 5xx, `api_error`, `server_error`, `Internal server error`, `UNAVAILABLE`, `ServiceUnavailableException`, `Provider returned error`, `you can retry your request` |
| `timeout` | yes | HTTP 408/504/524, `timed out`, `timeout`, `DEADLINE_EXCEEDED`, `ModelTimeoutException` |
| `transport` | yes | `fetch failed`, `ECONNRESET`, `ENOTFOUND`, `socket hang up`, `other side closed`, `terminated`, `stream ended before …`, `websocket closed`, `APIConnectionError` |
| `unknown` | yes | anything that matches nothing: unknown means transient, retried with backoff |
| `quota` | only with an accepted hint | HTTP 402, `insufficient_quota`, `exceeded your current quota`, `billing`, `out of budget`, `BudgetExceededError`, `Payment Required`, `usage limit` (ChatGPT, OpenCode), `available balance` |
| `auth` | no | HTTP 401/403, `authentication_error`, `permission_error`, `invalid_api_key`, `PERMISSION_DENIED`, `UNAUTHENTICATED`, `AccessDeniedException` |
| `not_found` | no | HTTP 404, `not_found_error`, `model_not_found`, `NOT_FOUND`, `ResourceNotFoundException` |
| `invalid_request` | no | HTTP 400/413/422, `invalid_request_error`, `INVALID_ARGUMENT`, `ValidationException`, `BadRequestError` |
| `content_policy` | no | `content_policy_violation`, `content_filter` |
| `context_overflow` | no | Pi's overflow patterns (`prompt is too long`, `exceeds the context window`, …), `context_length_exceeded`, `ContextWindowExceededError`, `request_too_large`; Pi's compaction owns these |

Rules, in order: user `patterns` are tested first (below); context overflow is never assumed for a 429 or 529 or a rate-limit or overload message (throttling messages say "too many tokens" too); deterministic wording beats transient wording, except that a recognised 408, 409, 429 or 5xx overrides `invalid_request` wording (OpenAI's 429 bodies say `invalid_request_error`); specific statuses beat transient wording, so a 400 that echoes "rate limit" stays `invalid_request`; transient wording beats a generic 5xx, so `503 The model is overloaded` is `overloaded`. A 5xx whose body carries `"code": 429` or `RESOURCE_EXHAUSTED` counts as a 429.

The HTTP status comes from the captured response, from diagnostics (`details.status`), or from the error text, where a code counts only at the start or after `status`, `HTTP`, `code` or `(`, so token counts, ports and timestamps are not mistaken for statuses. Diagnostic codes that Pi leaves out of the text (`details.errorCode`, `details.error.code`, `details.error.type`, `error.code`) are matched as well.

Every decision carries a reason naming its evidence, for example `auth: HTTP 401` or `rate_limit: HTTP 429; provider asked to wait 20s (header retry-after)`.

## Provider-requested waits

A hint is read from the first source that has one:

1. Response headers, when attributable (below): `retry-after-ms`, `retry-after` (seconds or HTTP-date) for every error status; for a 429 also `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens` (OpenAI durations such as `6m0s`), `anthropic-ratelimit-*-reset` (the latest wins), `x-ratelimit-reset`, `ratelimit-reset` (seconds or an epoch).
2. Diagnostics: `retryAfterMs`, `retryAfter`, `retryDelay` in a diagnostic's details.
3. The error text: OpenAI `try again in 1.2s` / `6m0s` / `250ms`, Pi's Codex message `Try again in ~12 min.` (`~0 min` is no hint), Google `"retryDelay": "28s"`, Pi's `Server requested 90s retry delay`, `retry after 30 seconds`, `retry-after: 30`, `resets in 5 minutes`, `resets at <ISO 8601 or epoch>`, `"resets_at": <epoch>`.

Times in the past, zero and unparsable values are no hint. A hint up to `maxRetryAfterMs` (default 30 minutes) is waited exactly, plus 250 ms, without jitter or backoff cap. A longer hint makes the failure non-retryable, whatever its category or your patterns, with the reason `provider asked to wait <duration>, limit is <duration>`.

### Header hints

Pi's `after_provider_response` event does not say which request a response belongs to, and whether it fires for error responses depends on the adapter:

| Adapter | Error-response headers |
|---|---|
| Mistral, pi-messages, OpenAI Codex over SSE (not the default WebSocket path), custom providers following the `streamSimple` contract | delivered |
| Anthropic, OpenAI Completions, OpenAI Responses, Azure Responses, Bedrock | not delivered: the SDK throws first |
| Google Generative AI, Google Vertex, Gemini CLI | never delivered |

pi-retry therefore uses header hints only when one request provably produces one response event: Pi's `cacheWarming` is `off` (prompt-cache warming requests share the event) and no warming request has run in the session (Pi reads `cacheWarming` from the global `settings.json` only, so set it there; a project setting can make `/retry` report `on` until the first warming request turns header hints off), `retry.provider.maxRetries` is 0 or unset (no provider-level retries inside one request), and the failed message's adapter is not `openai-codex-responses` (it retries internally). Only an error response received between the request's start and its end counts; a second response in one request turns header hints off for the session. `/retry` shows `headerHints: on` or `headerHints: off (<reason>)`, including the adapter rule for the selected model. With Pi's defaults (`cacheWarming: streaming`) header hints are off, and diagnostics and the error text still apply: OpenAI and Google put their waits in the text, Codex its usage-limit reset, and Anthropic 429s fall back to backoff.

Optional, for Anthropic, OpenAI Completions/Responses and Azure: Pi's provider-level retry turns a `retry-after` above its cap into the text `Server requested <n>s retry delay (max: <m>s)`, with seconds rounded up, which pi-retry reads. Setting `"retry": { "enabled": false, "provider": { "maxRetries": 1, "maxRetryDelayMs": 1 } }` surfaces every such header as text (a requested 1.2 s reads as 2 s), at the cost of one provider-level retry, after about half a second, for a retryable error that carries no `retry-after` header. This turns header hints from events off (provider retries are no longer 0), which matters only for the adapters in the first row.

## Configuration

`<agent-dir>/pi-retry.json` (by default `~/.pi/agent/pi-retry.json`), read at session start; changes apply after `/reload` or in a new session. Every key is optional:

```json
{
	"enabled": true,
	"maxRetries": 10,
	"baseDelayMs": 2000,
	"maxBackoffMs": 60000,
	"maxRetryAfterMs": 1800000,
	"patterns": {
		"retryable": ["backend saturated"],
		"nonRetryable": ["tenant suspended"]
	}
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether failures are retried; `/retry on` and `/retry off` change it for the session. |
| `maxRetries` | `10` | Retries of one failing request (integer 0–1000). Counts pi-retry's continuations only, not Pi's own retries. |
| `baseDelayMs` | `2000` | First backoff delay (integer 100–3 600 000); doubles per attempt. |
| `maxBackoffMs` | `60000` | Backoff cap (integer up to 86 400 000, at least `baseDelayMs`; a lower value is raised to it). Does not limit provider-requested waits. |
| `maxRetryAfterMs` | `1800000` | Longest provider-requested wait that is honoured (integer 0–86 400 000); `0` honours any wait. |
| `patterns.retryable` | `[]` | Regular expressions (case-insensitive) that make a failure retryable, even a deterministic one such as a quota error without a reset time. |
| `patterns.nonRetryable` | `[]` | Regular expressions that make a failure non-retryable. Wins over `retryable`. |

Patterns are matched against the error text and the diagnostic codes. They change the decision, not the category (`unknown` when no built-in rule matches), and neither lifts `maxRetryAfterMs`. A missing file means the defaults. Invalid JSON, an unknown key, an out-of-range value or an invalid pattern produces one warning per problem at session start and falls back to the default for that field only; a bad file never disables pi-retry.

## Reporting

Notifications go through `ctx.ui.notify` with these exact strings, so RPC clients can match them:

| Severity | Text |
|---|---|
| info | `pi-retry: <category> (<reason>); retry <attempt>/<max> in <duration>` when a wait starts |
| warning | `pi-retry: not retrying: <reason>` |
| warning | `pi-retry: giving up after <max> retries: <reason>` |
| info | `pi-retry: succeeded on retry <attempt>` |
| info | `pi-retry: retry cancelled` on Escape, `/retry cancel`, `/retry off`, a session switch or shutdown |
| info | `pi-retry: Pi's built-in retry is enabled and runs first; set "retry": { "enabled": false } in Pi settings to let pi-retry govern every attempt` |

In interactive mode they appear as notices and the countdown on the status line; in RPC mode they are forwarded through the extension UI channel; in JSON and print modes they are not delivered. In every mode each retry appends a `pi-retry` custom entry, which also appears in the JSON and RPC event streams as `entry_appended`:

```text
{ attempt, category, reason, delayMs, hintSource?, provider, model, outcome: "scheduled" | "cancelled" }
```

`outcome` is `scheduled` when the retry is sent; a follow-up entry with `cancelled` is appended when the run was aborted before the retried request started.

## License

[AGPL-3.0-only](https://github.com/ZeroClover/pi-extensions/blob/master/LICENSE)
