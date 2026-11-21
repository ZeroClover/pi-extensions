# Design

## Context

See proposal.md, "Why". The facts below were checked against Pi 1.6.0 under `node_modules/@earendil-works/`, by diffing a 1.5.0 copy, and by running copies of the code. The runs were:
- `classify()` over the texts below;
- a real Pi session with the scripted provider;
- the real `stream()` of both versions' pi-ai against local servers, including an HTTP proxy that answers CONNECT with chosen statuses.

Version labels come from Pi's `CHANGELOG.md`.

- **What Pi added to `isRetryableAssistantError`** (`pi-ai/dist/utils/retry.js`). Nothing was removed, and the non-retryable list and `overflow.js` are unchanged.
  - 1.5.1: `cut short after the reply had begun`, from a gateway relaying a dropped Anthropic stream (#11879).
  - 1.6.0: `connection.?closed`, a gateway mid-stream drop relayed as `{"type":"error","error":{"type":"api_error","message":"Connection closed."}}` (#12064).
  - 1.6.0: bare Node codes `(?<![a-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE)(?![a-z0-9_])` and `connection reset by peer` (#12128).
  - 1.6.0: `websocket.?connection.?limit.?reached`, Codex's 60-minute WebSocket lifetime limit (#12124). Pi's Codex adapter renders it as `Codex error: Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.` (`openai-codex-responses.js:575`, with OpenAI's documented message).
- **What pi-retry does with them today**:

  | Text | Today |
  |---|---|
  | `Connection closed.` | `unknown`, retried |
  | the `api_error` JSON form of it | `server_error`, retried |
  | `write ECONNABORTED` | `unknown`, retried |
  | the Codex rendering above, `websocket_connection_limit_reached` | `unknown`, retried |
  | `…cut short after the reply had begun` | `unknown`, retried |
  | `connect ETIMEDOUT 10.0.0.1:443` | `timeout` (`timed? ?out` matches `TIMEDOUT`), retried |
  | `connection reset by peer`, `read ECONNRESET`, `write EPIPE` | `transport`, retried |

- **Cause detail (#11695, 1.5.1).** `withCauseDetail` appends the deepest cause to the message. `anthropic-messages.js` calls it directly. `normalizeProviderError` calls it when there is no status and no body, which covers OpenAI Completions/Responses/Codex, Azure, Google, Vertex, Bedrock and others. Observed 1.5 → 1.6 renderings:
  - `Connection error.` becomes `Connection error.: read ECONNRESET`, `…: other side closed (UND_ERR_SOCKET)`, `…: self-signed certificate; … (DEPTH_ZERO_SELF_SIGNED_CERT)`. All of these are `transport` either way.
  - `terminated` becomes `terminated: Body Timeout Error (UND_ERR_BODY_TIMEOUT)`: `transport` → `timeout`, retried either way.
  - An HTTP proxy refusing CONNECT gives `Connection error.: Proxy response (NNN) !== 200 when HTTP Tunneling (UND_ERR_ABORTED)`, or with `fetch failed:` on raw-fetch adapters. `STATUS_IN_TEXT` treats `(` as a status position, so NNN becomes the status:

    | NNN | 1.6 result |
    |---|---|
    | 400, 413, 422 | `invalid_request`, stopped |
    | 401, 403 | `auth`, stopped |
    | 402 | `quota`, stopped without a hint |
    | 404 | `not_found`, stopped |
    | 407 | no mapped status, `transport`, retried |
    | 408, 504, 524 | `timeout`, retried |
    | 409, 429 | `rate_limit`, retried |
    | 529 | `overloaded`, retried |
    | 500, 502, 503 | `transport` (the wording beats a generic 5xx), retried |

    400, 401, 403, 404, 407, 408, 429, 500, 502, 503 and 504 were captured through the local proxy. 402, 409, 413, 422, 524 and 529 were run through `classify()` on that rendering. On 1.5 every one of these was `transport` and retried. Pi's own retry still retries all of them, because `connection.?error` matches.
  - Cause text takes part in ordinary matching. In a `classify()` run on the Node DNS error shape, `Connection error.: getaddrinfo ENOTFOUND unauthorized.example` is `auth` (from `unauthorized`) and stops, while Pi retries it. With `api.example.com` it is `transport`. (`billing.example` stops in both, because `billing` is also on Pi's non-retryable list.)
- **Quitting during a wait (#9126, 1.5.1).** `AgentSessionRuntime.dispose()` now runs `await this.session.abort()` before it emits `session_shutdown`. That abort waits for the run to go idle, and the run stays active through `agent_before_settle`, where pi-retry waits. During the wait `ctx.signal` is `undefined` (the agent has no active run), and no extension event fires before the abort. A scripted session (`runtime.dispose()` during an 8 s backoff) observed the following:
  - `dispose()` returned only when the countdown ended (6.4–7.3 s).
  - The provider received no second request.
  - pi-retry sent no cancel notice.
  - The session held a `scheduled` and then a `cancelled` `pi-retry` entry.

  Every shutdown during a wait goes through `dispose()`:
  - Interactive Ctrl+D, a double Ctrl+C (`interactive-mode.js` 3627–3639) or `/quit` stops the TUI first and then disposes (`interactive-mode.js` 3647–3678), so the screen is gone while Pi waits. Before stopping the TUI, Pi awaits `terminal.drainInput(1000)`. A Pi 1.6.0 PTY run with a local provider confirmed the timing matters: Ctrl+D early in a countdown made no second request; near its expiry the timer fired during the drain and the provider received the retry before disposal.
  - A SIGTERM or SIGHUP in interactive mode disposes before it stops the TUI.
  - In RPC mode, stdin EOF or a signal disposes; a second signal calls `process.exit` (`rpc-mode.js` 290–305, 589–596).
  - In print and JSON modes, a handled signal disposes and a second one exits (`print-mode.js` 25–50). Normal completion awaits the prompt, wait included, before disposing, so it never interrupts a wait.

  `session_shutdown` therefore arrives after the wait has ended, so pi-retry's handler finds no wait to cancel. Reload is refused while busy, and switch and fork are cancelled earlier by `session_before_switch` and `session_before_fork`, so no Pi 1.6 path delivers `session_shutdown` during a wait.
- **Other Pi behavior that the docs misstate.**
  - `AgentSession.reload()` throws `Wait for the current response to finish before reloading.` while streaming (#9222, 1.5.1). This covers `ctx.reload()` from an extension command (`rpc-mode.js:271`) and SDK hosts; the RPC protocol has no reload command.
  - `settings-defaults.js:60` sets `cacheWarming: "idle"` (1.5.1). `src/capture.ts` checks the setting on every gate evaluation (`!== "off"`), and only a `cache_warming_decision` event latches the gate closed.
  - The Codex usage-limit message is now built at `openai-codex-responses.js:1268-1280`; the code itself is unchanged.

## Goals / Non-Goals

**Goals:**
- Every pattern Pi 1.5.1 and 1.6.0 added to its retryable list is a named transient category in pi-retry, so the spec's "checked against Pi 1.6" is true.
- Every Pi-behavior statement in the README and the specs that this change touches is true for Pi 1.6.

**Non-Goals:**
- Changing how a status is read from text (D3).
- Matching ETIMEDOUT as `transport`. It is `timeout` today, a more specific transient category, and stays so.
- Ending a wait on quit in code, or reporting #9126's effect upstream (D6).

## Decisions

### D1. Widen the existing transport rules, add one

In `TRANSIENT_RULES`, transport group:

```ts
{ pattern: /connection.?(?:error|refused|lost|reset|closed)/i, category: "transport" },
{ pattern: /ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE/i, category: "transport" },
{ pattern: /websocket.?(?:closed|error|connection.?limit.?reached)/i, category: "transport" },
{ pattern: /cut short after the reply had begun/i, category: "transport" },
```

The code rule keeps its current form, without Pi's identifier guards, as pi-retry already treats `ECONNRESET` and `EPIPE`. A transient-only rule can at worst rename a retried failure. The transport group sits before the server-error group, so the `api_error` form of `Connection closed.` becomes `transport`: the precise wording beats the generic `api_error` type, and the decision stays "retried". The spec states this as an exception in "Anthropic error types".

The group's source note gains "Pi 1.5.1: #11879; Pi 1.6: #12064, #12128, #12124".

Alternative considered: one rule per Pi pattern, copied verbatim. Rejected: the existing rules group wording by meaning, and three of the four patterns extend a rule that is already there.

### D2. No change to the precedence

Deterministic wording, specific statuses and the transient groups listed before transport (rate limit, overload, timeout) still come first. So `401 Connection closed.` stays `auth`, `rate limit: Connection closed.` stays `rate_limit`, and a 429 that mentions a WebSocket stays `rate_limit`. The new scenario states its inputs as whole texts and repeats this precedence.

### D3. Keep reading the proxy's code as a status (owner's decision)

The rule "a three-digit code after `(` is a status" is unchanged, and the owner chose to keep the resulting stops.
- The stops are 400, 401, 403, 404, 413 and 422, and 402 without a hint. They are fixed answers from the proxy's policy or configuration: a blocked host, a forbidden or unknown target, a request it will not forward. Retrying up to `maxRetries` rarely helps.
- 407 Proxy Authentication Required stays retried only because 407 is outside the status map; mapping it is not part of this change.
- 408, 409, 429, 504, 524, 529 and generic 5xx answers are retried.

The spec records this under "HTTP status recognition" and as a difference from Pi. The README tells users that the reason (for example `auth: HTTP 403`) is about the proxy, not the provider key, and that `patterns.retryable: ["Proxy response"]` restores retrying unless a `nonRetryable` pattern matches or a hint is above the acceptance limit.

Alternative considered: exclude `Proxy response (NNN)` from the status positions in `src/classify.ts`, which restores 1.5's `transport` and retry. The owner declined it.

### D4. Cause text is matched like any other text

No special handling for the cause suffix. A host name or OS message in the cause can match deterministic wording, as `unauthorized.example` does. Where Pi's lists do not match the same word, this is a difference from Pi, which the spec lists. The README's precedence notes mention it next to D3. `patterns.retryable` overrides it.

Alternative considered: strip the cause before matching. Rejected: the cause is exactly what makes `read ECONNRESET`, `UND_ERR_BODY_TIMEOUT` and the proxy status visible, and it would add a provider-independent parser for a rare case.

### D5. Documentation

- **README cancellation table**:
  - The row "Shutdown or programmatic reload" is replaced by "Quit Pi (Ctrl+D, a double Ctrl+C, `/quit`, SIGTERM, SIGHUP off Windows, an RPC client closing its input)". If disposal aborts during the countdown, Pi waits it out without sending a retry and records `cancelled`. A keyboard quit closes the screen before disposal, but the countdown can expire and send a retry during the preceding input drain. Cancel first to quit at once. In print, JSON and RPC modes a second handled signal exits at once, before the wait ends, and leaves no `pi-retry` entry for that attempt.
  - The note under the table names `ctx.reload()` and SDK reloads next to `/reload` as refused while busy.
- **README notification table**: the `retry cancelled` row drops "shutdown", since Pi 1.6 delivers no shutdown during a wait.
- **README header-hint paragraph**: "With Pi's default `cacheWarming: idle`".
- **README `transport` row**: adds the wording of D1.
- **README precedence notes**: explain why `Connection closed.` beats the generic `api_error` type (D1), and add one paragraph on D3 and D4.
- **retry-hints spec**: "Warming enabled" names `idle` (Pi's default) or `streaming` as checked on every failure, and a new "Warming decision" scenario carries the latch.
- **retry-scheduling spec**: "Quitting Pi during the wait" next to "Session shutdown". The latter still describes the extension's reaction to the event, and notes that Pi 1.6 delivers it only after a wait. The reload scenario covers `ctx.reload()` and `AgentSession.reload()`.
- **retry-controls spec**: the `retry cancelled` notice on `session_shutdown` is limited to an event delivered during a wait, which Pi 1.6 does not do.
- **Historical markers stay as they are**: "added in Pi 1.4", "since Pi 1.5" and "since Pi 1.4" in the README, specs and source notes, and the test comments that name Pi 1.4 and 1.5. New behavior is dated by the Pi release that introduced it (1.5.1 or 1.6.0).

### D6. Quitting during a wait: documentation only (owner's decision)

pi-retry keeps its `session_shutdown` handler. It is still the correct reaction if Pi delivers the event during a wait, and the owner asked for no code change. The README and the retry-scheduling spec describe what users see and how to avoid it.

Alternatives considered:
- Ending the wait on Ctrl+D or a second Ctrl+C through the terminal-input listener that Escape already uses. Unverified whether the keys arrive before the TUI stops; it covers interactive mode only; the owner declined it.
- Reporting the interaction upstream so Pi aborts `agent_before_settle` handlers or announces shutdown first. The owner declined it for now.

### D7. Tests

New rows in `ROWS` of `test/classification.test.ts`, in a group for Pi 1.5.1 and 1.6 placed before the Pi 1.5 group. The existing setup runs a real session with `maxRetries: 0`, so each row checks the category and the decision. Each `category` also names the expected evidence, which the row's matcher reads as a regular-expression prefix of the reason. So a `transport: no known pattern` cannot pass for `transport: ECONNABORTED`.
- **Rows that fail before D1**: `Connection closed.`, its `api_error` JSON form, `503 Connection closed.` (a generic 5xx leaves the wording to decide), `write ECONNABORTED`, the Codex WebSocket rendering, `websocket_connection_limit_reached`, and the cut-short text.
- **Guards that pass before and after**:
  - `connect ETIMEDOUT 10.0.0.1:443` → `timeout`, and `connection reset by peer` → `transport`.
  - `401 Connection closed.` → `auth: HTTP 401`, stopped, and `rate limit: Connection closed.` → `rate_limit`, retried.
  - `Connection error.: getaddrinfo ENOTFOUND unauthorized.example` → `auth: unauthorized`, stopped, which pins D4.
  - The cause renderings `Connection error.: read ECONNRESET` → `transport` and `terminated: Body Timeout Error (UND_ERR_BODY_TIMEOUT)` → `timeout`.
  - The proxy renderings with 400, 402, 403 and 404 (stopped), the `fetch failed:` variant with 403 (stopped), and 407 and 502 (retried), which pin D3.

The rows pin the classifier for known inputs. They cannot notice Pi changing its rendering. A future Pi upgrade re-captures the renderings from the adapters, as this change did.

The quit behavior of D6 is Pi's, so the change adds no test for it. Task 3.1 re-checks the README statement with a scratch session under `_tmpwork/`.

## Risks / Trade-offs

- [A provider says "connection closed" about something permanent] → It is retried up to `maxRetries`, as it already was under `unknown`. `patterns.nonRetryable` overrides it.
- [A proxy returns 403 transiently, or a DNS failure names a host with deterministic wording such as `unauthorized`] → It stops where Pi 1.5.0 retried. The user re-sends, or adds a `patterns.retryable` entry.
- [A user quits during a long provider-requested wait] → Pi stays up to `maxRetryAfterMs` (30 min by default), with the screen already closed after a keyboard quit. The README says to cancel first; nothing else in this change mitigates it.
- [Pi changes the cause rendering or the shutdown order] → The next upgrade's review re-captures the renderings and re-runs the quit check.
