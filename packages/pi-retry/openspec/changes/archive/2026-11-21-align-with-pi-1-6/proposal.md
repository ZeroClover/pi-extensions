# Proposal

## Why

Pi 1.5.1 and 1.6.0 added transient wording to Pi's retryable list (#11879, #12064, #12128, #12124). pi-retry still retries those failures, but it files four of them as `unknown: no known pattern`. That breaks its spec's promise to cover every pattern of Pi's lists. Pi 1.5.1 also changed two things that the README and specs describe wrongly for the 1.6.0 baseline:
- it appends the transport cause to connection errors (#11695), which changes some retry decisions behind proxies;
- aborting for shutdown while a wait is active now waits it out (#9126).

## What Changes

- **New transport wording**: `connection closed`, `ECONNABORTED`, `websocket connection limit reached` and `cut short after the reply had begun` become `transport` when no higher-precedence status or wording decides the failure. Notices and session records name the matched wording instead of `unknown: no known pattern`. The Anthropic-style `api_error` event that says `Connection closed.` moves from `server_error` to `transport`. Every one of these is retried before and after the change.
- **Proxy tunnel refusals keep the new stop** (owner's decision). The error text now reads like `Connection error.: Proxy response (403) !== 200 when HTTP Tunneling (UND_ERR_ABORTED)`, and pi-retry reads the code as a status under its existing rules.
  - Stopped: a proxy answering 400, 401, 403, 404, 413 or 422, and 402 without a hint. On Pi 1.5.0 these were `transport` and retried.
  - Still retried: 407, which is outside the status map; 408, 409, 429, 504, 524, 529; and a generic 5xx.
  - Documented as a difference from Pi, which retries all of them. `patterns.retryable: ["Proxy response"]` restores retrying, subject to the usual precedence of `nonRetryable` patterns and the hint acceptance limit.
- **Quitting during a wait is documented** (owner's decision: documentation only). Since Pi 1.5.1, Pi aborts the run and waits for it to settle before it sends `session_shutdown`, and pi-retry cannot observe that abort. If the abort starts during the wait, Pi waits until the countdown ends; no retry is sent and the attempt is recorded as cancelled. Keyboard quit drains input before the abort, so a countdown expiring during the drain can still send a retry. The README and the retry-scheduling spec say this, and tell users to cancel first (Escape or `/retry cancel`). Code does not change.
- **Documentation follows Pi 1.6**:
  - The README's `transport` row gains the new wording, and its precedence notes gain the proxy-tunnel status and the effect of cause text.
  - The cancellation table drops "programmatic reload", which Pi refuses during a wait (#9222).
  - The README and the retry-hints spec say Pi's default `cacheWarming` is `idle`, not `streaming`.
  - The spec's "checked against" and "built-in lists" statements read Pi 1.6.
  - The Codex line reference in `src/vocabulary.ts` is updated.
- **Regression scenarios**: new rows in the end-to-end classification table, confirmed to fail before the fix, plus guards for wording that already works and for the proxy renderings.

Out of scope:

- Control flow, scheduling and the header-gate logic. The gate already treats any `cacheWarming` other than `off` as closed.
- Mitigating the quit wait in code, and reporting it upstream (owner's decision).
- Other Pi 1.5.1–1.6.0 changes that do not affect pi-retry; the per-plugin review found none.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `error-classification`:
  - `HTTP status recognition` gains the proxy-tunnel scenario.
  - `Provider vocabulary` is checked against Pi 1.6. It gains the Pi 1.5.1/1.6 transport scenario and the `api_error` exception. Its documented differences from Pi gain the proxy tunnel and cause-text matching.
- `retry-hints`: `Header capture gate` names `idle` as Pi's default `cacheWarming`, and separates the setting, which is checked on every failure, from a warming decision, which latches.
- `retry-scheduling`: `Cancellable wait` gains "Quitting Pi during the wait", notes on "Session shutdown" that Pi 1.6 delivers the event only after a wait, and extends the reload scenario to `ctx.reload()` and `AgentSession.reload()`.
- `retry-controls`: `Reporting` says the cancel notice on `session_shutdown` applies only to an event delivered during a wait, which Pi 1.6 does not do.

## Impact

- **Source files**: `packages/pi-retry/src/vocabulary.ts` gets three widened transport rules, one new transport rule and updated source notes. `src/classify.ts`, `src/index.ts` and `src/controller.ts` do not change.
- **Documentation**: `packages/pi-retry/README.md`:
  - the cancellation table and the note under it;
  - the `transport` row;
  - the precedence notes;
  - the header-hint paragraph;
  - the notification table's `retry cancelled` row.
- **Tests**: new rows in `packages/pi-retry/test/classification.test.ts`.
- **Release**: `src/` and `README.md` are published content, so this needs a `patch` intent for `@zeroclover/pi-retry`.
- **Delivery**: ships in the Pi 1.6.0 upgrade pull request, as `align-classifier-with-pi-1-5` did for Pi 1.5.
- **Unchanged**: configuration keys, commands, notification strings and session-record shapes.
