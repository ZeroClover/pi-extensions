---
"@zeroclover/pi-retry": patch
---

Header hints stay on for the session after a Bedrock throttle that the AWS SDK retried, and Codex requests served over SSE now honour retry-after headers. Pi's Codex usage-limit message without a reset time (or with "Try again in ~0 min.") is now a rate limit retried with backoff. The gateway and stream errors Pi 1.4 retries get a category, Anthropic's low-credit error reads as quota, and the README is corrected for Pi 1.4.
