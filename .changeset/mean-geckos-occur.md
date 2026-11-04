---
"@zeroclover/pi-web-access": patch
---

A web_search or web_fetch call that arrives while a key command is still running now waits for that command with a full timeout, instead of ending it and prompting the password manager again.
