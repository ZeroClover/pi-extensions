---
"@zeroclover/pi-retry": patch
---

Zhipu/Z.ai plan usage limits (error code 1308, or 使用上限 in the message) now count as quota: without an accepted retry hint they stop instead of being retried until maxRetries runs out.
