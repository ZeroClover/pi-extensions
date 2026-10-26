---
"@zeroclover/pi-retry": patch
---

The README now explains how Codex errors relayed in the response stream are classified: a usage limit there is not retried, because Pi drops its reset time, while a rate limit is retried with backoff.
