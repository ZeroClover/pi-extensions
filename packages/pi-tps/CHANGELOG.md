# @zeroclover/pi-tps

## 0.2.0

### Minor Changes

- Redesigned readout: while a request streams, its live TPS and TTFT are shown beside the serving model's smoothed averages (`68.3 (x̄52.3) TPS | TTFT 0.6s (x̄1.1s)`) and coloured by how they compare with them; between requests the line shows the averages and the run's progress; when idle it shows the current model's averages with totals over every run of the session (runs and their time, requests, input and cache share, output, thinking, cost) instead of the last run's summary.
- Averages are kept per provider and model and smoothed so that one slow or fast request barely moves them; they are rebuilt from the session's records, so they survive resume, `/reload` and `/tree`. Behind a virtual model they follow the physical model that served the requests.
- One fixed notation replaces the `text` and `symbols` label styles; the stall field and the `~` estimate marker are gone, and an unknown value reads `-`.
- **Breaking configuration:** `labels`, `summaryMode` and `thresholds` are removed (each now gives one warning) in favour of `tps` and `ttft` settings with a `mode` (`relative`, the default, or `absolute`) and `relative` / `absolute` threshold lists; override values become `{ "tps"?, "ttft"? }`. New keys: `separator`, `separatorColor`, `burstColor` and `calibration` (`false` disables token calibration). To keep the previous TPS colouring, move `thresholds` to `tps.absolute` and set `tps.mode` to `"absolute"`.
- `/tps` only shows or hides the readout; `/tps mode` is removed.
- **Breaking event payload:** the `pi-tps:status` snapshot now has the phases `waiting`, `streaming`, `working` and `idle`, with the model's averages and, when idle, the session totals. Request records keep version 2 and gain an optional `requested` model.

## 0.1.1

### Patch Changes

- The README's license link now opens the license on npmjs.com and in installed copies of the package; it pointed outside the package before.

## 0.1.0

### Minor Changes

- First public release: a tokens-per-second readout in Pi's footer. While a request streams it shows the live generation rate (thinking included), while tools run it shows the run's progress, and when the run settles it shows one summary: TPS, time to first token, output and thinking tokens, thinking time, stalls, and cost. It detects burst delivery, calibrates streamed token estimates per provider and model, and `/tps` toggles the readout or switches the idle summary.
