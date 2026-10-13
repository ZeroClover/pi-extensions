---
"@zeroclover/pi-tps": minor
---

First public release: a tokens-per-second readout in Pi's footer. While a request streams it shows the live generation rate (thinking included), while tools run it shows the run's progress, and when the run settles it shows one summary: TPS, time to first token, output and thinking tokens, thinking time, stalls, and cost. It detects burst delivery, calibrates streamed token estimates per provider and model, and `/tps` toggles the readout or switches the idle summary.
