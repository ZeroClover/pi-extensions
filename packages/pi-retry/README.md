# pi-retry

Automatic retry for failed model requests in Pi. Pi's built-in retry matches errors with a single regular expression, waits at most 60 s, and ignores the wait time a provider asks for. As a result, a 429 asking to wait 90 s fails after three quick retries, and unrecognised transient errors are never retried. pi-retry steps in once Pi gives up, classifying the error and waiting as long as the provider asks.

- Classifies errors by category and stops immediately on deterministic failures (auth, invalid request, context overflow, …).
- Honours provider-requested waits from headers, diagnostics, or error text up to a configurable limit, and backs off exponentially with jitter otherwise.
- Retries on the same context with the failed attempt hidden from the model and preserved in the session file.
- Works in interactive, RPC, JSON, and print modes.

## Install

Published to npm as `@zeroclover/pi-retry` and tagged `@zeroclover/pi-retry@<version>` with release notes from `CHANGELOG.md`.

```bash
pi install npm:@zeroclover/pi-retry             # install a published version for the user
pi -e ./packages/pi-retry                       # try a repository checkout for one session
pi install /absolute/path/to/packages/pi-retry  # install a repository checkout for the user
```

**Turn off Pi's built-in retry.** Add this to Pi's `settings.json`:

```jsonc
{ "retry": { "enabled": false } }
```

pi-retry acts only after Pi's built-in retry declines a failure or exhausts its budget, and Pi resets that budget before every pi-retry continuation. If both are left on with default limits (Pi: 3 retries, pi-retry: 10), a failing request can trigger up to 44 attempts (11 from pi-retry, each followed by up to 3 from Pi). While Pi's retry is enabled, pi-retry warns once per session; it never modifies Pi's settings.

## Provides

| Kind | Name | Description |
|---|---|---|
| command | `/retry` | Show the effective configuration, the header-hint state, and the current state (`idle`, or `waiting` with the attempt, remaining seconds, and reason). |
| command | `/retry cancel` | End the wait in progress without retrying, and abort the run. |
| command | `/retry off` / `/retry on` | Stop or resume retrying for this session; `off` also cancels an active wait. Resets to the configured `enabled` value on `/reload` or session switch. |
| status | `pi-retry` | `retry 2/10 in 30s`, counting down every second during a wait and cleared when it ends. |
| session entry | `customType: "pi-retry"` | One record per retry (see [Reporting](#reporting)); never sent to the model. |

Any other argument to `/retry` prints the usage.

## How a failure is handled

1. A request ends with an error. Pi's built-in retry and overflow compaction run first. Once Pi settles on the failure, pi-retry steps in unless another extension has already asked to continue or drafted a compaction.
2. pi-retry classifies the failure (see [Error categories](#error-categories)). If it is non-retryable, pi-retry reports `pi-retry: not retrying: <reason>` and leaves the failed message as the last message.
3. If `maxRetries` is exhausted, pi-retry reports `pi-retry: giving up after <max> retries: <reason>`.
4. Otherwise it starts a wait. With an accepted provider hint, it waits the requested duration plus 250 ms. Without a hint, it waits `min(baseDelayMs × 2^(attempt−1), maxBackoffMs)` multiplied by a random factor between 0.75 and 1.0. It reports `pi-retry: <category> (<reason>); retry <attempt>/<max> in <duration>`.
5. When the wait finishes, pi-retry hides the failed message from model context via a `context_edit` entry (keeping it in the session file), appends a `pi-retry` session entry, and re-sends the request. If the retried request succeeds, it reports `pi-retry: succeeded on retry <attempt>`.

The attempt counter resets after a successful response, an aborted response or run, or a new user prompt.

### Ending a wait

| Action | Result |
|---|---|
| Press Escape (interactive mode) | Ends the wait immediately without retrying or recording an entry. Reports `pi-retry: retry cancelled`. |
| `/retry cancel` or `/retry off` | Same as Escape, in any mode that runs commands. |
| Type a message during a backoff wait | Ends the wait within 1 s and sends the retry together with your message. |
| Type a message during a provider-requested wait | Keeps counting down and sends your message with the retry at the provider's deadline. Cancel first to drop the retry. |
| Switch, start, or fork a session | Ends the wait before Pi replaces the session; no retry is sent. |
| Shutdown or programmatic reload | Ends the wait immediately; no retry is sent. |
| Abort from an RPC client | pi-retry cannot observe this abort, so the wait runs to completion and Pi then discards the retry. The empty failed message is hidden, and the `pi-retry` entry is followed by one with `outcome: "cancelled"`. Use `/retry cancel` to stop the wait itself. |

Cancelling a wait also aborts the run so queued messages do not fire before the provider's deadline; Pi then handles queued messages as on any abort. Pi refuses `/reload` while the session is busy (including during a wait): cancel first, then reload.

## Configuration

Read from `<agent-dir>/pi-retry.json` (default `~/.pi/agent/pi-retry.json`) at session start; changes apply after `/reload` or in a new session. Every key is optional:

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
| `enabled` | `true` | Whether failures are retried. `/retry on` and `/retry off` override this for the session. |
| `maxRetries` | `10` | Maximum retries for a single failing request (integer `0`–`1000`). Counts only pi-retry continuations, not Pi's built-in retries. |
| `baseDelayMs` | `2000` | First backoff delay in ms (integer `100`–`3600000`); doubles with each attempt. |
| `maxBackoffMs` | `60000` | Backoff cap in ms (integer up to `86400000`, at least `baseDelayMs`; lower values are raised to `baseDelayMs`). Does not limit provider-requested waits. |
| `maxRetryAfterMs` | `1800000` | Longest provider-requested wait honoured, in ms (integer `0`–`86400000`; `0` honours any wait). |
| `patterns.retryable` | `[]` | Case-insensitive regular expressions that force a failure to be retryable, including deterministic errors such as quota errors without a reset time. |
| `patterns.nonRetryable` | `[]` | Case-insensitive regular expressions that force a failure to be non-retryable. Overrides `patterns.retryable`. |

Patterns are matched against the error text and diagnostic codes. They change whether the failure is retried, not its category (`unknown` when no built-in rule matches), and never bypass `maxRetryAfterMs`.

A missing file uses the defaults. Invalid JSON, unknown keys, out-of-range values, or invalid regular expressions produce one warning per problem at session start and fall back to the default for that field only; a bad configuration file never disables pi-retry.

## Error categories

| Category | Retried | Examples |
|---|---|---|
| `rate_limit` | yes | HTTP 409/429, `rate_limit_error`, `rate_limit_exceeded`, `Too many requests`, `ThrottlingException`, `RESOURCE_EXHAUSTED`, Google's per-minute `Quota exceeded for quota metric …`, LiteLLM `No healthy deployment available` |
| `overloaded` | yes | HTTP 529, `overloaded_error`, `The model is overloaded`, `model is at capacity`, `server_busy`, `high demand` |
| `server_error` | yes | other 5xx, `api_error`, `server_error`, `Internal server error`, `UNAVAILABLE`, `ServiceUnavailableException`, `Provider returned error`, `you can retry your request` |
| `timeout` | yes | HTTP 408/504/524, `timed out`, `timeout`, `DEADLINE_EXCEEDED`, `ModelTimeoutException` |
| `transport` | yes | `fetch failed`, `ECONNRESET`, `ENOTFOUND`, `socket hang up`, `other side closed`, `terminated`, `stream ended before …`, `websocket closed`, `APIConnectionError` |
| `unknown` | yes | anything that matches no rule; treated as transient and retried with backoff |
| `quota` | only with an accepted hint | HTTP 402, `insufficient_quota`, `exceeded your current quota`, `billing`, `out of budget`, `BudgetExceededError`, `Payment Required`, `usage limit` (ChatGPT, OpenCode), `available balance` |
| `auth` | no | HTTP 401/403, `authentication_error`, `permission_error`, `invalid_api_key`, `PERMISSION_DENIED`, `UNAUTHENTICATED`, `AccessDeniedException` |
| `not_found` | no | HTTP 404, `not_found_error`, `model_not_found`, `NOT_FOUND`, `ResourceNotFoundException` |
| `invalid_request` | no | HTTP 400/413/422, `invalid_request_error`, `INVALID_ARGUMENT`, `ValidationException`, `BadRequestError` |
| `content_policy` | no | `content_policy_violation`, `content_filter` |
| `context_overflow` | no | Pi's overflow patterns (`prompt is too long`, `exceeds the context window`, …), `context_length_exceeded`, `ContextWindowExceededError`, `request_too_large` (handled by Pi's compaction) |

Classification follows these precedence rules:

1. User `patterns` are checked first (see [Configuration](#configuration)).
2. `context_overflow` is never matched on HTTP 429 or 529, or when rate-limit or overload wording is present (throttling messages often mention "too many tokens").
3. Deterministic wording beats transient wording, except that HTTP 408, 409, 429, or 5xx overrides `invalid_request` wording (OpenAI 429 bodies carry `invalid_request_error`).
4. Specific statuses (every status named in the table above, as opposed to a generic 5xx) beat transient wording, so a 400 that echoes "rate limit" stays `invalid_request`.
5. Transient wording beats a generic 5xx, so `503 The model is overloaded` is classified as `overloaded`.
6. A 5xx whose body contains `"code": 429` or `RESOURCE_EXHAUSTED` is treated as HTTP 429.

The HTTP status is read from the captured response, from diagnostics (`details.status`), or from the error text (matched only at the start of the string or after `status`, `HTTP`, `code`, or `(`, so token counts, ports, and timestamps are ignored). Diagnostic codes omitted from the error text (`details.errorCode`, `details.error.code`, `details.error.type`, `error.code`) are also matched. Every decision records a reason naming its evidence, such as `auth: HTTP 401` or `rate_limit: HTTP 429; provider asked to wait 20s (header retry-after)`.

## Provider-requested waits

A wait hint is read from the first source that provides one:

1. **Response headers** (when attributable; see below): `retry-after-ms` and `retry-after` (seconds or HTTP-date) on any error status; on HTTP 429 also `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens` (OpenAI durations such as `6m0s`), `anthropic-ratelimit-*-reset` (the latest timestamp wins), `x-ratelimit-reset`, and `ratelimit-reset` (seconds or epoch).
2. **Diagnostics**: `retryAfterMs`, `retryAfter`, or `retryDelay` in a diagnostic's `details`.
3. **Error text**: OpenAI `try again in 1.2s` / `6m0s` / `250ms`, Pi's Codex message `Try again in ~12 min.` (`~0 min` is ignored), Google `"retryDelay": "28s"`, Pi's `Server requested 90s retry delay`, `retry after 30 seconds`, `retry-after: 30`, `resets in 5 minutes`, `resets at <ISO 8601 or epoch>`, and `"resets_at": <epoch>`.

Past timestamps, zero, and unparsable values are ignored. A hint up to `maxRetryAfterMs` (default 30 minutes) is waited in full, plus 250 ms, without jitter or backoff cap. A longer hint makes the failure non-retryable, regardless of category or user patterns, with the reason `provider asked to wait <duration>, limit is <duration>`.

### Header hints

Pi's `after_provider_response` event does not identify which request a response belongs to, and whether it fires on error responses depends on the provider adapter:

| Adapter | Error-response headers |
|---|---|
| Mistral, pi-messages, OpenAI Codex over SSE (not the default WebSocket path), custom providers following the `streamSimple` contract | delivered |
| Anthropic, OpenAI Completions, OpenAI Responses, Azure Responses, Bedrock | not delivered: the SDK throws first |
| Google Generative AI, Google Vertex, Gemini CLI | never delivered |

Because of this, pi-retry uses header hints only when a single request is guaranteed to produce at most one response event:

- Pi's `cacheWarming` is `off` and no warming request has run in the session, because warming requests share the response event. Pi reads `cacheWarming` from the global `settings.json` only; a project-level setting can make `/retry` report `on` until the first warming request turns header hints off.
- `retry.provider.maxRetries` is `0` or unset (no SDK retries inside a single request).
- The failed message's adapter is not `openai-codex-responses` (which retries internally).

Only an error response received between the request's start and end is used; a second response during one request disables header hints for the rest of the session. `/retry` reports `headerHints: on` or `headerHints: off (<reason>)`, including the adapter rule for the selected model. With Pi's default `cacheWarming: streaming`, header hints are off, and pi-retry falls back to diagnostics and error text (OpenAI and Google include waits in error text, Codex includes usage-limit resets, and Anthropic 429s use exponential backoff).

**Optional header-to-text bridge (Anthropic, OpenAI Completions/Responses, Azure):** Pi's provider-level retry converts a `retry-after` header above its cap into the error message `Server requested <n>s retry delay (max: <m>s)` (seconds rounded up), which pi-retry parses from the text. Setting `"retry": { "enabled": false, "provider": { "maxRetries": 1, "maxRetryDelayMs": 1 } }` in Pi's `settings.json` surfaces every `retry-after` header as text (a requested 1.2 s becomes 2 s). The trade-off is one extra provider-level retry (after about 0.5 s) on retryable errors without a `retry-after` header, and event-based header hints are turned off because provider retries are non-zero (which affects only the adapters in the first row above).

## Reporting

Notifications are sent via `ctx.ui.notify` with these exact strings so RPC clients can match them:

| Severity | Text |
|---|---|
| info | `pi-retry: <category> (<reason>); retry <attempt>/<max> in <duration>` when a wait starts |
| warning | `pi-retry: not retrying: <reason>` |
| warning | `pi-retry: giving up after <max> retries: <reason>` |
| info | `pi-retry: succeeded on retry <attempt>` |
| info | `pi-retry: retry cancelled` on Escape, `/retry cancel`, `/retry off`, session switch, or shutdown |
| info | `pi-retry: Pi's built-in retry is enabled and runs first; set "retry": { "enabled": false } in Pi settings to let pi-retry govern every attempt` |

In interactive mode these appear as notices alongside the countdown on the status line; in RPC mode they are forwarded over the extension UI channel; in JSON and print modes they are omitted.

In every mode, each retry appends a `pi-retry` custom session entry (which also appears in JSON and RPC event streams as `entry_appended`):

```text
{ attempt, category, reason, delayMs, hintSource?, provider, model, outcome: "scheduled" | "cancelled" }
```

`outcome` is `scheduled` when the retry is sent; a follow-up entry with `cancelled` is appended if the run was aborted before the retried request started.

## License

[AGPL-3.0-only](https://github.com/ZeroClover/pi-extensions/blob/master/LICENSE)
