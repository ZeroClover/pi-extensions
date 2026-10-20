# Proposal

## Why

Pi's built-in agent-level retry (`settings.retry`) decides retryability with a single regular expression over the error text, retries at most a few times with a delay capped at 60 s, and never reads the wait a provider asks for: a 429 that says "try again in 90 s" is retried at 2 s, 4 s and 8 s and then surfaces as a failure, while an error whose wording Pi does not know (a new gateway, a proxy, a gRPC backend) is never retried at all. Long-running sessions on rate-limited or multi-provider setups therefore stop on errors that would have succeeded a minute later, and the user has to notice and resend by hand.

## What Changes

- New package `packages/pi-retry`: an extension that takes over after a failed model request and, when the failure is retryable, waits and re-sends the request on the same context, keeping the failed attempt in the session file but out of the model context, exactly as Pi's own retry does.
- A provider-neutral error classifier with an explicit taxonomy: deterministic failures (authentication, permission, not found, invalid request, content policy, context overflow, quota and subscription limits without a usable reset time) are **not** retried; rate limits, overload, server errors, timeouts, transport failures and gateway "try again" responses are retried; an error that matches nothing is treated as transient and retried with backoff. The vocabulary is drawn from Pi's own patterns, LiteLLM's exception mapping, and the provider APIs Pi ships (Anthropic, OpenAI Completions/Responses/Codex, Google, Bedrock, Mistral, OpenRouter, LiteLLM proxy, gRPC backends) and is extensible from the configuration file.
- Retry-after awareness: the wait a provider requests is read from structured diagnostics, from the error text, and from HTTP headers when Pi exposes them for the failed request and the extension can prove which request they belong to (Pi does not correlate `after_provider_response` to a request, so header hints are gated on `cacheWarming: off`, no provider-level retries, and a non-Codex adapter) (OpenAI "try again in …", Google `retryDelay`, Pi's "Server requested Ns retry delay", ChatGPT usage-limit reset times, generic "retry after N seconds" / "resets at …"). A requested wait is honoured as-is up to a configurable limit (default 30 minutes); a longer one makes the error non-retryable and the user is told how long the provider asked for.
- Exponential backoff with jitter for retryable errors that carry no retry hint, bounded by a configurable base delay, cap, and maximum attempt count; the attempt counter resets on the first successful response or on a new user prompt.
- Configuration file `<agent-dir>/pi-retry.json` with `enabled`, `maxRetries`, `baseDelayMs`, `maxBackoffMs`, `maxRetryAfterMs`, and `patterns` (user-defined retryable / non-retryable patterns that take precedence over the built-in vocabulary). Invalid fields fall back to their default with a warning.
- Session controls: `/retry` shows the effective configuration and the current attempt state; `/retry cancel` ends a wait in progress without retrying; `/retry on` and `/retry off` toggle the extension for the session. While waiting, the status line shows the attempt and remaining time; Escape cancels the wait; a queued user message ends a backoff wait early (a provider-requested wait keeps its deadline) and is delivered with the retry.
- Works in interactive, RPC, JSON and print modes: no behaviour depends on terminal UI.

Pi's own retry is left untouched. pi-retry acts only once Pi has settled on a failure (after Pi's retry declined or exhausted its budget), so the two compose; the README recommends `"retry": { "enabled": false }` in Pi's settings so that pi-retry's classification and timing govern every attempt.

## Capabilities

### New Capabilities
- `error-classification`: assigns every failed model request a category and a retry decision from the error text, diagnostics and captured HTTP status, with a provider-neutral vocabulary, user-defined overrides, and "unknown means transient".
- `retry-hints`: extracts the wait a provider asks for from response headers, diagnostics and error text, normalises it to a delay, and applies the configurable acceptance limit.
- `retry-scheduling`: the attempt budget, the delay (hint or exponential backoff with jitter), the cancellable wait, and the continuation that re-sends the request with the failed attempt omitted from model context.
- `retry-configuration`: the `pi-retry.json` file, its schema, defaults and validation.
- `retry-controls`: the `/retry` command, status-line and notification reporting, and the interaction with Pi's own retry and with queued messages.

### Modified Capabilities
<!-- none: this is the package's first change -->

## Impact

- New files only: `packages/pi-retry/src/*`, `packages/pi-retry/test/*`, `packages/pi-retry/README.md`, a row in the root `README.md`.
- Pi APIs used: `pi.on("agent_before_settle")` (boundary result with a `context_edit` omission draft and `continue: true`), `pi.on("after_provider_response")`, `pi.on("message_end")`, `pi.on("before_agent_start")`, `pi.on("session_start")`, `pi.on("session_shutdown")`, `pi.on("session_before_switch")`, `pi.on("session_before_fork")`, `pi.on("context")`, `pi.on("cache_warming_decision")`, `pi.on("agent_settled")`, `pi.registerCommand`, `pi.appendEntry`, `ctx.ui.onTerminalInput`, `pi.getSettings()`, `ctx.ui.notify` / `setStatus`, `ctx.hasPendingMessages()`, `getAgentDir()`; `isContextOverflow` from `@earendil-works/pi-ai`.
- Peer dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` (for `matchesKey`). No runtime dependencies.
- No change to Pi settings, to other packages, or to shared tooling.
