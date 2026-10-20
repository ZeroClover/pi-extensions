# @zeroclover/pi-retry

## 0.1.0

### Minor Changes

- First release: retries failed model requests after Pi gives up on them, re-sending the request on the same context with the failed attempt hidden from the model and kept in the session.
- Errors are classified by provider-neutral rules covering Anthropic, OpenAI, Google, Bedrock, Mistral, OpenRouter, LiteLLM and gRPC wording. Deterministic failures (auth, not found, invalid request, content policy, context overflow, quota without a reset time) stop at once; rate limits, overload, server errors, timeouts, transport failures and unrecognised errors are retried. `patterns` in the configuration force or forbid a retry for your own wording.
- A wait the provider asks for (from response headers, diagnostics or the error text, such as `retry-after` or "try again in 90s") is honoured up to `maxRetryAfterMs` (30 minutes by default); a longer one stops with the requested duration. Other failures back off exponentially with jitter.
- `/retry` shows the configuration and the current wait, `/retry cancel` ends a wait, and `/retry off` / `/retry on` turn retries off or on for the session; Escape also ends a wait. Configuration lives in `pi-retry.json` in Pi's agent directory. Turn off Pi's built-in retry (`"retry": { "enabled": false }`) so pi-retry governs every attempt.
