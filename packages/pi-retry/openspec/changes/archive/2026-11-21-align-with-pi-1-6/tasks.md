# Tasks

## 1. Pi 1.5.1 and 1.6 transport wording (error-classification: Provider vocabulary)

- [x] 1.1 Add a `// Pi 1.5.1 and 1.6 additions to its retryable list (#11879, #12064, #12128, #12124), and cause renderings (#11695).` group to `ROWS` in `packages/pi-retry/test/classification.test.ts`, just before the `// Pi 1.5 addition to its non-retryable list` comment, with these rows. The `category` value includes the expected evidence (design D7). "Today" is the notice on the current code:

  | Source | Text | Decision | Category | Today |
  |---|---|---|---|---|
  | gateway mid-stream drop (#12064) | `Connection closed.` | retried | `transport: Connection closed` | `unknown: no known pattern` |
  | the same drop as an Anthropic-style error event | `{"type":"error","error":{"type":"api_error","message":"Connection closed."}}` | retried | `transport: Connection closed` | `server_error: api_error` |
  | the same drop behind a generic 5xx: the wording decides, the status stays recognised | `503 Connection closed.` | retried | `transport: Connection closed` | `server_error: HTTP 503` |
  | bare Node code (#12128) | `write ECONNABORTED` | retried | `transport: ECONNABORTED` | `unknown: no known pattern` |
  | Codex WebSocket lifetime limit: Pi's `Codex error:` wrapper around OpenAI's documented message, not captured (#12124) | `Codex error: Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.` | retried | `transport: websocket connection limit reached` | `unknown: no known pattern` |
  | Codex WebSocket lifetime limit, as a code (#12124) | `websocket_connection_limit_reached` | retried | `transport: websocket_connection_limit_reached` | `unknown: no known pattern` |
  | gateway relaying a dropped Anthropic stream (#11879) | `Claude Code's stream from Anthropic was cut short after the reply had begun` | retried | `transport: cut short after the reply had begun` | `unknown: no known pattern` |
  | bare Node code, guard: stays timeout | `connect ETIMEDOUT 10.0.0.1:443` | retried | `timeout` | same |
  | guard | `connection reset by peer` | retried | `transport` | same |
  | guard: a status decides first | `401 Connection closed.` | stopped | `auth: HTTP 401` | same |
  | guard: rate-limit wording decides first | `rate limit: Connection closed.` | retried | `rate_limit` | same |
  | cause rendering, guard | `Connection error.: read ECONNRESET` | retried | `transport` | same |
  | cause text matched like the rest, guard (design D4) | `Connection error.: getaddrinfo ENOTFOUND unauthorized.example` | stopped | `auth: unauthorized` | same |
  | cause rendering of a stalled stream, guard | `terminated: Body Timeout Error (UND_ERR_BODY_TIMEOUT)` | retried | `timeout` | same |

  Before touching `src/`, run `pnpm vitest run packages/pi-retry/test/classification.test.ts` from the repository root. Confirm that it fails with exactly the first seven rows differing, as in the "Today" column, and that no guard row appears in the failure. Record this result for the final report.
- [x] 1.2 Apply design D1 to the transport group of `TRANSIENT_RULES` in `packages/pi-retry/src/vocabulary.ts`:
  - widen the `connection.?(…)` rule with `closed`;
  - add `ECONNABORTED` to the Node code rule;
  - widen the WebSocket rule with `connection.?limit.?reached`;
  - add `/cut short after the reply had begun/i`.

  Add "Pi 1.5.1: dropped Anthropic streams relayed by gateways (#11879). Pi 1.6: gateway `Connection closed.` (#12064), bare Node codes (#12128), the Codex WebSocket lifetime limit (#12124)." to the group's source comment. Verify that `pnpm vitest run packages/pi-retry` passes with every 1.1 row, and that no other row was edited.
- [x] 1.3 In the `transport` row of `packages/pi-retry/README.md`, add `ECONNABORTED` after `ECONNRESET`. Add `websocket connection limit reached`, `connection closed` and `cut short after the reply had begun` after `websocket closed`. Verify that the row names every alternative that 1.2 added.

## 2. Proxy tunnel status and cause text (error-classification: HTTP status recognition, Provider vocabulary; design D3, D4)

- [x] 2.1 Add these guard rows to the 1.1 group, where `<P>(NNN)` stands for `Connection error.: Proxy response (NNN) !== 200 when HTTP Tunneling (UND_ERR_ABORTED)`. They pass before and after this change and pin D3:

  | Source | Text | Decision | Category |
  |---|---|---|---|
  | HTTP proxy refuses the tunnel, cause rendering (#11695) | `<P>(403)` | stopped | `auth: HTTP 403` |
  | the same with a bad request | `<P>(400)` | stopped | `invalid_request: HTTP 400` |
  | the same with an unknown target | `<P>(404)` | stopped | `not_found: HTTP 404` |
  | the same with payment required, no hint | `<P>(402)` | stopped | `quota` |
  | raw-fetch adapters' rendering of the same refusal | `fetch failed: Proxy response (403) !== 200 when HTTP Tunneling (UND_ERR_ABORTED)` | stopped | `auth: HTTP 403` |
  | proxy asks for credentials: 407 is not a mapped status | `<P>(407)` | retried | `transport: Connection error` |
  | proxy's upstream fails: the wording beats a generic 5xx | `<P>(502)` | retried | `transport: Connection error` |

  Verify that `pnpm vitest run packages/pi-retry/test/classification.test.ts` passes.
- [x] 2.2 Add one paragraph to the precedence notes under the category table in `packages/pi-retry/README.md`. It covers three points:
  - Since Pi 1.5.1 the error text carries the transport cause. A proxy's refusal of the CONNECT tunnel therefore reaches pi-retry as, for example, `Connection error.: Proxy response (403) !== 200 when HTTP Tunneling` (or with `fetch failed:`). The code counts as a status: 400, 401, 403, 404, 413 and 422 stop, and so does 402 without a hint. The reason, such as `auth: HTTP 403`, is about the proxy, not the provider key. 407, 408, 409, 429, 504, 524, 529 and other 5xx answers are retried.
  - Cause text is matched like the rest of the message, so a host name such as `unauthorized.example` in a DNS error can make it `auth`.
  - Adding `Proxy response` (or the host name) to `patterns.retryable` retries them, unless a `nonRetryable` pattern matches or a hint is above the acceptance limit.

  Verify with `rg -n "Proxy response|unauthorized.example" packages/pi-retry/README.md`.

## 3. Statements about Pi 1.6

- [x] 3.1 In the cancellation table of `packages/pi-retry/README.md`, replace the row `Shutdown or programmatic reload` with a row for quitting Pi (Ctrl+D, a double Ctrl+C, `/quit`, SIGTERM, SIGHUP off Windows, an RPC client closing its input). If disposal starts during the wait, Pi waits out the countdown before exiting; no retry is sent, and the `pi-retry` entry records `cancelled`. Keyboard quit drains input before closing the screen and starting disposal; if the countdown expires during that drain, a retry can start. Cancel first (Escape or `/retry cancel`) to quit at once. In print, JSON and RPC modes a second handled signal exits at once, before the wait ends, and leaves no entry for that attempt (design D5, D6).
  - Extend the sentence under the table: Pi refuses `/reload`, `ctx.reload()` from an extension command, and SDK reloads while the session is busy, including during a wait.
  - In the notification table, change the `retry cancelled` row to "on Escape, `/retry cancel`, `/retry off`, or session switch".
  - Verify with `rg -n "programmatic reload|or shutdown" packages/pi-retry/README.md`, which must print nothing.
  - Re-check the quit statement with a scratch end-to-end session under `_tmpwork/`, not committed. Call `runtime.dispose()` during a backoff wait, and confirm that it returns after the countdown, that the provider receives no second request, and that the entries are `scheduled` then `cancelled`.
- [x] 3.2 In the header-hint paragraph of `packages/pi-retry/README.md`, change "With Pi's default `cacheWarming: streaming`" to "With Pi's default `cacheWarming: idle`". Verify that `rg -n "cacheWarming: streaming" packages/pi-retry/README.md` prints nothing and `rg -n "cacheWarming: idle" packages/pi-retry/README.md` prints the paragraph.
- [x] 3.3 Change the Codex reference in the comment on `CODEX_NO_RESET_RULE` in `packages/pi-retry/src/vocabulary.ts` to `openai-codex-responses.js:1268-1280`. Verify with `rg -n "let friendlyMessage|friendlyMessage = .You have hit" packages/pi-retry/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js`, which must print lines 1268 and 1280.
- [x] 3.4 Verify the version statements with `rg -n "Pi 1\.[0-9]" packages/pi-retry/README.md packages/pi-retry/src packages/pi-retry/openspec/changes/align-with-pi-1-6/specs`.
  - Every `Pi 1.4` or `Pi 1.5` it prints must be one of the historical markers that design D5 keeps, or a `Pi 1.5.1` that dates new behavior.
  - The delta's "checked against" and "built-in lists" statements must read Pi 1.6.

## 4. Release and verification

- [x] 4.1 Record the release decision from the repository root:

  ```
  pnpm change --bump patch --summary "Failures Pi added to its retry list in 1.5.1 and 1.6 (connection closed, ECONNABORTED, the Codex WebSocket connection limit, streams cut short by a gateway) are classified as transport instead of unknown or server_error. The README documents Pi 1.6 behavior: a proxy that refuses the tunnel with 400, 401, 403, 404, 413 or 422, or 402 without a hint, is not retried; cancel the wait before quitting Pi to exit promptly and avoid a last-moment retry." @zeroclover/pi-retry
  ```

  Verify with `pnpm change status`.
- [x] 4.2 Run `pnpm check` from the repository root and make sure it passes. Run `openspec validate align-with-pi-1-6 --strict` from `packages/pi-retry/` and make sure it passes. Report both as run. Also report that no request reached a real gateway or proxy: the scenarios use the scripted provider, with texts taken from Pi's source and from local-server captures of Pi's adapters.

## Workflow follow-up

- Archive the change after review, syncing the deltas into `packages/pi-retry/openspec/specs/{error-classification,retry-hints,retry-scheduling,retry-controls}/spec.md`. Then confirm that the main spec's "checked against" and "built-in lists" statements read Pi 1.6.
- Commit in the Pi 1.6.0 upgrade pull request as `fix(pi-retry): classify Pi 1.6 transport wording and align docs with Pi 1.6`, when a commit is requested.
