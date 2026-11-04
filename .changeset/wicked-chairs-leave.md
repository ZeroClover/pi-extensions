---
"@zeroclover/pi-retry": patch
---

Zhipu/Z.ai account, plan and API key errors (codes 1113, 1309-1311, 1313-1321) are no longer retried as rate limits: plan and balance limits count as quota and stop without an accepted retry hint, and model or API key restrictions (1311, 1315) count as auth and stop.
