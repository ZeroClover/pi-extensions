# Proposal

## Why

pi-retry was written against Pi 1.3.0. An audit of its claims about Pi against the 1.4.0 sources (the current target) found three problems. Several claims are wrong or out of date. The header-capture gate excludes the wrong adapter. The classifier lacks the error wording Pi 1.4 added to its retry list.

The most serious defect predates 1.4. The README says Bedrock never delivers error-response headers. In fact Pi's Bedrock middleware reports every HTTP response, and on a throttle the AWS SDK makes up to three attempts (two retries) inside one request, outside `retry.provider.maxRetries`. With the gate open, the first Bedrock throttle therefore produces several captures, and header hints stay off for the rest of the session, on every adapter.

## What Changes

- **Header capture gate**:
  - Exclude `bedrock-converse-stream`, whose SDK retries inside one request, so that one Bedrock throttle no longer closes header hints for the whole session.
  - Stop excluding `openai-codex-responses`. Its internal retry loop runs only when `retry.provider.maxRetries` is above 0, which the gate already rules out, and its WebSocket path never reports a response. Codex requests served over SSE then get header hints like the other adapters that deliver them. That covers the `sse` transport and the default `auto` transport after a WebSocket fallback.
- **Pi 1.4 vocabulary**:
  - Pi 1.4 added these retryable phrases: `stream disconnected before completion`, `stream was interrupted`, `http/2 stream failed`, `request to <url> failed, reason:`, `upstream request failed`, and `upstream_stream_read_error`.
  - Give each a real category (`transport` or `server_error`) and a reason that names the evidence, instead of `unknown: no known pattern`. The retry decision for these phrases does not change.
- **Quota before invalid request**: deterministic quota wording wins over `invalid_request` wording. Anthropic's low-credit error (`invalid_request_error … credit balance is too low … Plans & Billing`) then reads `quota`. The decision is the same without a hint. With an accepted reset hint, the error is now retried.
- **Codex 429 without a reset time** (owner's decision): Pi's Codex adapter renders every 429 whose JSON error body has no `resets_at` as `You have hit your ChatGPT usage limit.`, including a transient `rate_limit_exceeded` (and any other status whose error `code` or `type` names a usage or rate limit). Today pi-retry classifies that as `quota` and never retries it. It becomes `rate_limit` and is retried with exponential backoff. `Try again in ~0 min.`, which Pi writes when the reset is under 30 s away or already past, gets the same treatment. The message with `Try again in ~N min.` for N ≥ 1 stays `quota` with its hint.
- **Spec truth**: rewrite the scenario "Pi's lists are covered with documented differences" to state where pi-retry's decision differs from Pi 1.4's. Each difference is given as a verified example; the scenario no longer claims exhaustive equivalence with an exception list.
  - Pi 1.4 recognises a status number anywhere that no letter or digit touches it (#11057). The scenario still says Pi retries a bare status number anywhere, which is out of date.
  - Today the scenario also contradicts "Quota with hint inside the limit". The rewrite removes that contradiction.
- **README truth**:
  - The intro: Pi uses a deny list checked before an allow list, plus an overflow check. "60 s" is `retry.maxAgentDelayMs`. Provider-level retry does honour `retry-after`.
  - The adapter table: Bedrock delivers error headers once per SDK attempt. Remove "Gemini CLI", which is not a Pi adapter.
  - The Codex gate rule.
  - The header-to-text bridge: Codex over SSE also produces `Server requested …`. The extra provider retry waits 375–500 ms, or 1 s on Codex.
  - Update the source notes in `src/vocabulary.ts` and `src/capture.ts` to match.
  - `/retry`'s warming gate reason says "a cache-warming decision occurred" instead of "a cache-warming request ran". Pi also emits the decision event when it decides not to warm.

Out of scope, recorded in design.md as open questions:
- Wider status positions in error text.
- Reading `cacheWarming` through `SettingsManager`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `error-classification`:
  - `Retry decision by category` lists the Pi 1.4 workplace usage-limit code among the quota wording.
  - `Provider vocabulary` gains the Pi 1.4 wording, the Codex no-reset rule, and an accurate list of the differences from Pi's decision.
  - `Deterministic categories take precedence` orders quota wording ahead of invalid-request wording, and names the Codex no-reset message as its one transient exception.
- `retry-hints`: `Text hints` treats `Try again in ~0 min.` as no reset time; `Header capture gate` excludes `bedrock-converse-stream` instead of `openai-codex-responses`.

## Impact

- **Source files**:
  - `packages/pi-retry/src/capture.ts`: the excluded adapter.
  - `packages/pi-retry/src/vocabulary.ts`: new transient rules, the Codex no-reset rule, deterministic group order, and source notes.
  - `packages/pi-retry/src/classify.ts`: the Codex no-reset rule, checked against the raw error message before the deterministic wording.
  - `packages/pi-retry/src/index.ts`: a comment.
- **Documentation**: `packages/pi-retry/README.md`.
- **Tests**:
  - New end-to-end scenarios in `packages/pi-retry/test/`.
  - `tools/e2e/src/provider.ts` gains two optional fields on a scripted `Response`:
    - `api`, the adapter the failed message names.
    - `priorResponses`, earlier HTTP responses that `onResponse` reports, as an SDK's internal retries do.

    Both are generic, like the existing `model` and `diagnostics` fields. They are needed to script a Bedrock or Codex failure and the Bedrock multi-response bug. This is a shared-tooling change shipped with this pull request.
- **Release**: `src/` and `README.md` are published content, so this needs a `patch` intent for `@zeroclover/pi-retry`. It covers bug fixes, classification precision, and documentation corrections, and adds no command or setting.
- **Unchanged**: configuration keys, commands, notifications, and session-record shapes. The only exception is the wording of one `/retry` gate reason.
