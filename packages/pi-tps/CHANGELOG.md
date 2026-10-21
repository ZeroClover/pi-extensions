# @zeroclover/pi-tps

## 0.3.1

### Patch Changes

- A response's calibration samples are stored with one write instead of up to four, so less synchronous disk I/O runs when a response ends.

## 0.3.0

### Minor Changes

- The live TPS leaves out delivery backlogs: everything that arrives in the first 300 ms of a phase or after a pause (text generated during TTFT, a thinking phase or the pause) no longer counts, so the figure no longer starts far above the steady rate and then decays. It appears 1.8 s after output starts instead of 1.5 s.
- While a thinking phase streams, the live TPS is the thinking tokens so far over the thinking time so far, so it no longer drops towards 0 in the silences between summary chunks.
- An answer that starts with the backlog of a thinking phase is no longer marked as burst (`cluster`); a flush after a long stall still is.
- The settled rate of a request without a thinking phase counts its output by the same rules, so the backlog generated during TTFT no longer inflates it or the model's TPS average. Its `generatedTokens` and `generationMs` hold the counted figures (`generatedTokens` can be fractional); answers with less than 1.3 s of output have no rate of their own.

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
