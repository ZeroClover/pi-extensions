---
"@zeroclover/pi-retry": patch
---

Failures Pi added to its retry list in 1.5.1 and 1.6 (connection closed, ECONNABORTED, the Codex WebSocket connection limit, streams cut short by a gateway) are classified as transport instead of unknown or server_error. The README documents Pi 1.6 behavior: a proxy that refuses the tunnel with 400, 401, 403, 404, 413 or 422, or 402 without a hint, is not retried; cancel the wait before quitting Pi to exit promptly and avoid a last-moment retry.
