---
"@zeroclover/pi-retry": minor
---

First release: retries failed model requests after Pi gives up on them. Errors are classified by provider-neutral rules, deterministic failures (auth, not found, invalid request, content policy, context overflow, quota without a reset time) stop at once, provider-requested waits from headers, diagnostics and error text are honoured up to a configurable limit, and other failures back off exponentially with jitter. The failed attempt is hidden from the model and kept in the session. /retry shows the configuration and state, cancels a wait, or turns retries off for the session; configuration lives in pi-retry.json in Pi's agent directory.
