---
"@zeroclover/pi-web-access": patch
---

web_search now treats null arguments as omitted instead of searching for site:null or failing, rejects a null query, and both tools no longer repeat their name in the system prompt.
