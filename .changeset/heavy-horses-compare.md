---
"@zeroclover/pi-tps": minor
---

Redesigned readout: live TPS and TTFT are shown beside the serving model's smoothed averages and coloured relative to them (or by absolute thresholds per metric), and the idle line shows the current model's averages with session totals; one fixed notation replaces the text and symbol label styles. Configuration changes: `labels`, `summaryMode` and `thresholds` are removed in favour of `tps` / `ttft` settings with relative and absolute threshold lists, overrides take `{ tps, ttft }`, and `separator`, `separatorColor`, `burstColor` and `calibration` are new. `/tps` only toggles the readout. The `pi-tps:status` snapshot now has the phases waiting, streaming, working and idle with averages and session totals; request records gain an optional `requested` model.
