# Design

## Context

Current inventory (see proposal.md, "Why", for the motivation):

| Area | Test files | Lines | What they exercise |
|---|---|---|---|
| `packages/pi-tps/test/` | 15 | ~4,000 | measurement arithmetic over injected clocks, estimator, averages, calibration store over a simulated file system, config parser, formatter, renderer |
| `packages/pi-retry/test/` | 10 | ~2,300 | classifier over a 40+ string table, hint parser, controller over hand-built `agent_before_settle` payloads and a `FakePi` |
| `packages/pi-rtk/test/` | 6 | ~630 | controller over a fake `run` function, adapters, outcome mapping, `runFile`, plus a contract check against the real `rtk` |
| `tools/release/test/` | 15 | ~2,200 | pure validators (batch, ledger, coverage, manifest, changelog, intents) and `flow.test.ts`, which already drives commands against real git with GitHub and registry doubles, and `load.test.ts` |

These tests check that each module computes what it computes today. None checks that Pi delivers the events the module expects, in the shape and order it expects. The same goes for whether pnpm writes the files the release tooling parses, and whether rtk's exit codes still mean what pi-rtk assumes.

### Verified facts the design relies on

A throwaway spike, run against the installed Pi 1.1.0 and not committed, established the following. The repository accepts no JavaScript sources, so the spike is not checked in. Its TypeScript equivalents are the first scenarios that use the harness: K1 reproduces facts 1–3, P1–P3 reproduce fact 4, R1 and R5 reproduce fact 5, and L1 reproduces fact 8.

1. **An in-process session loads real packages.** `createAgentSessionRuntime` with `createAgentSessionServices({ resourceLoaderOptions: { additionalExtensionPaths: ["<repo>/packages/<name>"], extensionFactories: [probe] } })` loads each package through its `package.json` `pi` manifest. The probe extension registers the test provider with `pi.registerProvider(provider)` and subscribes to `pi.events`, which is shared with the loaded packages.
2. **pi-rtk rewrites what is really executed.** The scripted provider called Pi's real `bash` tool with `git status`. A fake `rtk` on `PATH` answered `rewrite` with exit 3 and `rtk git status`, and printed a marker when run. The tool result the model received was that marker.
3. **Pi's faux provider is not enough on its own.** `fauxProvider()` never calls `onPayload`, so Pi never emits `before_provider_request`, and pi-tps records nothing. It calls `onResponse` only with status 200 and no headers, so pi-retry's header hints cannot be exercised. A provider built with `createProvider` whose stream calls `options.onPayload` and `options.onResponse` before streaming fixes this: pi-tps measured 181.7 tok/s against a faux rate of 200.
4. **Timing can be scripted.** A stream written with `createAssistantMessageEventStream()` and real `setTimeout` delays produced the expected records:

   | Scenario | Result |
   |---|---|
   | 100 tok/s steady | 97.0 tok/s |
   | 2 s streamed thinking, then text | `thinking: "streamed"`, `thinkingMs` 1975, TPS over thinking plus output |
   | 1.5 s silence, then one flush | `burst: true`, `burstReason: "few-batches"`, TTFT 1502 ms |
   | 1.5 s mid-stream pause | 1 stall of 1501 ms, TPS 95.2 |

5. **pi-retry's full loop works in process.** With `retry.enabled: false` in in-memory settings and `pi-retry.json` setting `baseDelayMs: 100`, a `429 Too Many Requests` error set the status to `retry 1/10 in 1s` and then cleared it. The second request's context held only `[system, user]`: the failed message was hidden from the model. `session.prompt("/retry cancel")` sent during a 3 s wait ran immediately, ended the run at 0.6 s, and the provider was called once.
6. **The UI context must carry its members as own properties, with a concrete theme.** Pi's runner spreads the bound UI context (`{ ...ui }`, `ExtensionRunner.wrapUIPromptContext`), which copies only own enumerable properties. Proxy-based recorders and class prototype methods are lost, and a getter is evaluated once. `ctx.ui.theme` must be a concrete `Theme`. The `theme` singleton and `getThemeByName` are not public exports, only the `Theme` class and `initTheme` are, and the package's `exports` map forbids deep imports.
7. **Shutdown needs the runtime.** `AgentSession.dispose()` does not emit `session_shutdown`. `AgentSessionRuntime.dispose()` does, and it also provides `newSession`, `switchSession`, and `fork` with Pi's real `session_before_switch` and `session_start` reasons. pi-tps's ticker stopped and the process exited cleanly after `runtime.dispose()`.
8. **Real pnpm runs offline and fast.** In a temporary git workspace with a `versioning` block, `pnpm change --bump minor --summary … @zeroclover/pi-a` and `pnpm version -r` produced the intent, `.changeset/ledger.yaml`, and `CHANGELOG.md` offline in about 50 ms each. `pnpm version -r` requires a clean working tree.

## Goals / Non-Goals

**Goals:**
- A small set of end-to-end scenarios per package. Each one is tied to a spec requirement and a named failure, and each would catch a broken contract with Pi, rtk, pnpm, or the registry.
- One harness that new packages reuse without writing session plumbing.
- A testing convention in the docs that keeps future work from drifting back to module tests.

**Non-Goals:**
- No source changes. Test-only seams in `src/` (injected `now`, `run`, `getEnv`, exported constants) stay. Removing them would change published content and needs its own change and release decision.
- No coverage of the arithmetic at the precision the old tests pinned (see "Deliberately not covered").
- No new Pi or release behavior, and no change to the load test.

## Decisions

### D1. The end-to-end boundary is an in-process `AgentSessionRuntime`, not a `pi --mode rpc` subprocess

The harness runs Pi's real session runtime, agent loop, extension runner, tools, session manager, and settings in the test process. It replaces three things: the model provider, the terminal (a recording `ExtensionUIContext` bound with `mode: "tui"` or `"rpc"`), and external programs (temporary executables on `PATH`).

Alternative: drive `pi --mode rpc` as a subprocess. Rejected. Scripting the provider would require serializing every response, delay, and error through files into a helper extension. TUI-mode behavior (the pi-tps footer, Escape handling in pi-retry) is unreachable over RPC. Failures surface as protocol noise instead of stack traces. The one thing the subprocess adds, the `pi` binary loading the package through jiti, is already covered by `tools/release/test/load.test.ts`, which stays.

### D2. Harness API (`tools/e2e/src/`)

A sketch. The implementer may rename, but must keep the capabilities:

```ts
const pi = await startPi({
  extensions: ["pi-retry"],                 // packages/<name> dirs, loaded as `pi -e` loads them
  mode: "tui",                              // ctx.mode; "rpc" for non-TUI behavior
  settings: { retry: { enabled: false } },  // Pi settings, in memory
  agentFiles: { "pi-retry.json": { baseDelayMs: 100 } }, // written into the agent dir
  agentDir,                                 // optional, caller-owned and shared (P8); default: a fresh temp dir
  env: { PATH: `${bin}:${process.env.PATH}` },           // applied until dispose, then restored
  session: { file: true },                  // default in-memory; file-backed when resume is under test
  tools: ["bash"],
  customTools: [execCommandStub],           // stand-ins for third-party tools (exec_command, bg_run)
});
pi.provider.respond(
  text("hello", { firstTokenMs: 300, tokensPerSecond: 100 }),
  failure({ message: "429 Too Many Requests", status: 429, headers: { "retry-after": "1" } }),
);
await pi.prompt("go");              // also runs slash commands, e.g. pi.prompt("/retry cancel")
pi.provider.requests;               // contexts the provider received, with timestamps
pi.ui.notices;                      // [{ level, message }]
pi.ui.status("pi-tps");             // history of setStatus(key, text)
pi.ui.press("\x1b");                // raw terminal input to onTerminalInput handlers
pi.events.collect("pi-tps:telemetry");
pi.entries();                       // session entries, including custom ones
const resumed = await pi.reopen();  // new runtime on the same session file and agent dir
pi.session; pi.runtime;             // Pi's own public API: abort, steer, setModel, navigateTree, newSession
await pi.dispose();                 // AgentSessionRuntime.dispose(): emits session_shutdown
```

Rules for the harness:
- **Scripted provider.** Built with `createProvider` and `createAssistantMessageEventStream`. Every request calls `onPayload`, then `onResponse` with the scripted status and headers (default 200), then streams. Steps cover text, thinking (streamed, or hidden as start and end events with no deltas), tool calls, a pause before any step, a single-chunk flush, and an error end (`stopReason: "error"`, `errorMessage`, optional status and headers). A response can also set usage and report a different serving `model`, to stand in for a virtual model. The provider registers at least two models (for example `scripted/a` and `scripted/b`), exposes them as `pi.provider.models`, and the session starts on the first; P7 switches to the second. A response may be a function of the request context, so a scenario can assert on what the model was sent. The stream honours `options.signal`: an abort ends it at once with `stopReason: "aborted"`, so abort scenarios do not wait for the script to run out.
- **Recording UI.** An object implementing the whole `ExtensionUIContext` interface whose every member, `theme` included, is an own property: an object literal, or class fields holding arrow functions, never prototype methods (fact 6). It records `notify`, `setStatus`, `setWidget`, and working-indicator calls, and lets `press()` feed `onTerminalInput` handlers. Dialogs resolve to scripted answers, `undefined` by default.
- **Theme.** Built with the public `Theme` constructor. Every token maps to a distinct colour, and TypeScript enforces that the maps are complete. Assertions strip ANSI codes, and compare colours only where colour is the behavior under test.
- **Isolation.** Each `startPi` call gets a fresh working directory, and a fresh agent directory unless the caller passes `agentDir`, under the OS temp dir. On dispose it removes what it created and leaves a caller-owned `agentDir` alone. `PI_OFFLINE=1`. `process.env` changes are restored on dispose. Sessions within a test file run one after another.
- **Strictness.** The harness is ordinary root tooling under `tsconfig.json` and Biome: no deep imports into Pi's `dist/`, no casts, no `any`. `tools/e2e/src/` and any worker script started with plain `node` use only syntax that Node's type stripping accepts (no `enum`, parameter properties, or `namespace`), like `tools/release/src/`, because Vitest's transpiler would hide a violation that only fails in the worker.

### D3. Package-specific fixtures stay with the package

The fake `rtk` script, stub `exec_command` and `bg_run` tools, the provider error table, and the calibration worker live in `packages/<name>/test/`. Only generic machinery goes into `tools/e2e/`. A generic helper that writes an executable into a temporary `bin` directory qualifies; the `rtk` behavior it writes does not. This follows AGENTS.md rule 1.

### D4. Time-dependent assertions use bands

`performance.now` is not injectable, and the harness must not inject it. Rates are asserted within ±30% of the scripted rate. A slow runner only lengthens intervals, which lowers the measured rate, so the lower bound is the one that matters. Durations are asserted as lower bounds: TTFT is at least the scripted first-token delay, and `thinkingMs` is at least 90% of the scripted thinking time. Upper bounds are used only where the behavior is "early", for example a retry that proceeds before its backoff, and then with a margin of at least 1 s. Each scenario scripts at most a few seconds of streaming.

### D5. Release tooling is tested at the CLI process boundary

The tests run `node tools/release/src/cli.ts <command>` as a child process inside a temporary git repository (the current `git-repo.ts` is deleted, and its `TestRepo` is rewritten to run git and pnpm through `node:child_process` instead of importing `src/exec.ts`). That repository is a minimal pnpm workspace with one or two tiny plugins, and a gitignored `node_modules/.bin/pi` symlinked to the workspace's `pi`, which `verify` and `preflight` invoke.
- Release files come from real `pnpm change --bump … --summary …` and `pnpm version -r`, committed between steps, because `pnpm version -r` needs a clean tree (fact 8). The hand-written intent, ledger, and changelog templates in `fixtures.ts` are deleted.
- GitHub is a `gh` executable placed first on `PATH`. It answers the `gh api --include` calls of `src/github.ts` (commit-to-pull association, tag refs, tag creation, release lookup) and `gh release create` (recording the tag and the `--notes-file` content, and refusing an unknown tag as `--verify-tag` does) from a JSON state file that the test seeds and inspects. The state can make a named call fail once, for the recovery rows of L3.
- The npm registry is a local `node:http` server in the test process. It serves packuments and tarballs to `lookupVersion` and `tarballAvailable` through `--registry`. It accepts the `PUT` that `pnpm publish` sends, with the registry and a dummy auth token for its host supplied through the child's environment or a temporary `.npmrc`. A `PUT` merges the version into the packument and makes its tarball downloadable immediately, so the CLI's `--publish-wait-timeout` availability wait returns at once instead of running into the 60 s test timeout. It records every upload so a test can prove that a rerun uploads nothing, and it can answer one lookup with a 500 for the recovery rows of L3.

Alternative: keep calling the exported command functions with injected `Deps`, as `flow.test.ts` does today. Rejected, because it skips argument parsing, the `gh` and HTTP adapters, the `pnpm publish` invocation, and the exit-code contract the workflows rely on. There is no fallback to it: `cli.ts` builds its publish effects internally, so substituting them would need a `src/` change and would break the process-boundary requirement. If the local registry cannot be made to accept `pnpm publish`, the implementer stops and the change is revised instead.

### D6. Scenario catalogue

Each row becomes one `it(...)` whose name states the failure it prevents. Several assertions in one scenario are fine when they share a session. The anchor is the spec requirement in `packages/<name>/openspec/specs/` or `openspec/specs/`.

#### pi-rtk (fake `rtk` on `PATH` that logs every invocation with its cwd)

| # | Scenario | Failure prevented | Anchor |
|---|---|---|---|
| K1 | The model calls `bash` with `git status`. The tool executes `rtk git status` (marker in the tool result). The `exec_command` stub receives the rewritten `cmd`, and `rtk rewrite` runs in the call's `workdir`. | Rewrite not applied, applied to the wrong field, or run in the wrong directory | command-rewriting: Rewrite before execution. tool-adapters: Built-in adapters, Working directory |
| K2 | `rtk rewrite` exits 2 with a message: the tool result is the block `rtk: <message>` and nothing runs. Exit 2 without a message: the original command runs. Exit 1: unchanged. | A deny message executed as a command, or a deny without a message blocking work | command-rewriting: Exit-code contract |
| K3 | `tty: true`, `shell: "pwsh"`, `shell: false`, a command starting with `rtk`, and a nonexistent `workdir` each reach the tool byte-identical, and the rtk log shows no `rewrite` call for them | Interactive or non-POSIX commands corrupted by RTK | tool-adapters: Skip rules |
| K4 | No `rtk` on `PATH`: one warning, status `RTK unavailable`, the command runs unchanged. An `rtk` that sleeps past the 2 s timeout: the command runs unchanged each time, and the third failure sends one suspension warning and sets `RTK suspended`. After the fake is healed, `/rtk on` resumes rewriting. | A missing or hung rtk blocking or slowing every command | command-rewriting: Fail open. rtk-availability: Check at session start, Suspend after repeated failures |
| K5 | `/rtk off` leaves commands unchanged, `/rtk on` restores rewriting, and `/rtk` reports the state and counts. With `RTK_DISABLED=1`, the rtk log stays empty, `--version` included. | Controls that do not control | rewrite-controls: Status command, Session switch, Environment switch, Footer status |
| K6 | `pi-rtk.json` adds `bg_run` (stub tool, rewritten) and disables `bash` (unchanged). An `exec_command` entry with an unknown key warns and keeps the built-in adapter, so a `tty: true` call is still skipped. | A config typo stripping the PTY or shell guard | tool-adapters: Configured adapters |
| K7 | Runs only when `rtk` 0.25.0 or newer is on `PATH`, and is skipped otherwise. With the real `rtk`, `git status` is rewritten, while `vim notes.txt`, `-h`, and `rtk git status` are left unchanged. | RTK changing its exit-code or argument contract under pi-rtk | command-rewriting: Exit-code contract |

#### pi-retry (Pi's built-in retry disabled unless stated; `baseDelayMs: 100`)

| # | Scenario | Failure prevented | Anchor |
|---|---|---|---|
| R1 | `429 Too Many Requests`, then success. The wait notice and countdown status appear, then clear. The retried request's context ends with the user message, so the failed message is hidden. The session file keeps the failed message plus a `context_edit` entry and a `pi-retry` entry with `outcome: "scheduled"`. Finally `succeeded on retry 1`. | Retrying into a context that still contains the failure, losing the session record, or never retrying | retry-scheduling: Trigger point, Continuation. retry-controls: Reporting |
| R2 | `401 invalid_api_key`: `not retrying: auth: …` and one request. `503` twice, then success: `succeeded on retry 2`. A persistent `503` with `maxRetries: 2`: exactly three requests, then `giving up after 2 retries`. A new prompt afterwards starts with a fresh budget. | Hammering a provider on auth errors, or an unbounded retry loop | error-classification: Retry decision by category. retry-scheduling: Attempt budget, Retry of retries |
| R3 | Real provider error texts with `maxRetries: 0`, one session, one prompt each. The reported prefix shows the decision without any waiting: `giving up after 0 retries: <category>…` when retryable, `not retrying: <category>…` when not. Rows: one real text per category and one per provider family in the spec's Provider vocabulary (Anthropic, OpenAI, Google and gRPC, Bedrock, LiteLLM, subscription and ChatGPT usage limits, Google per-minute quota, billing), merged where one text serves both, plus the README precedence traps (OpenAI 429 body containing `invalid_request_error` → rate_limit; 400 echoing "rate limit" → invalid_request; `503 The model is overloaded` → overloaded; overflow wording on a 429 → rate_limit; `prompt is too long` → context_overflow; quota without a reset → not retried; quota with `try again in 2s` → retried), plus one `patterns.retryable` and one `patterns.nonRetryable` row from config. | Misclassifying a real provider error: retrying a deterministic failure, or giving up on a transient one | error-classification: Category taxonomy, Deterministic categories take precedence, HTTP status recognition, Provider vocabulary, User-defined patterns |
| R4 | The error text `Please try again in 1.2s`: the retry request starts at least 1.45 s after the failure, and the record carries `hintSource`. `try again in 5s` with `maxRetryAfterMs: 1000`: not retried, with the limit reason. With `cacheWarming: "off"`, a 429 response carrying `retry-after: 1` and no hint in the text gives a header-sourced wait. With Pi's default `cacheWarming`, the same response falls back to backoff, and `/retry` reports `headerHints: off (cacheWarming is not off)`. A message steered in during the 1.2 s hinted wait does not make the retry go early: the retry still starts no earlier than the deadline, and carries the message. | Ignoring a provider's requested wait (also when the user types during it), waiting beyond the limit, or trusting unattributable headers | retry-hints: Header hints, Text hints, Acceptance limit, Header capture gate. retry-scheduling: Cancellable wait. retry-controls: Queued messages |
| R5 | During a 5 s backoff: `/retry cancel` notifies `retry cancelled`, ends the run, and sends no second request. In TUI mode, `press("\x1b")` does the same. A message steered in with `session.steer` makes the retry go early, more than 1 s before the backoff ends, together with the message. `runtime.newSession()` during a wait ends it without a retry. | A wait that cannot be escaped, or that blocks the user's next message or a session switch | retry-scheduling: Cancellable wait. retry-controls: Queued messages |
| R6 | With Pi's retry enabled, the layering notice appears once. A `pi-retry.json` with one invalid value gives one warning naming the field, and the next transient failure is still retried with defaults. | A bad config silently disabling retries, or the two retry layers multiplying unseen | retry-controls: Coexistence with Pi's retry. retry-configuration: Validation and fallback |

#### pi-tps (scripted timing, `pi-tps:telemetry`/`pi-tps:run`/`pi-tps:status` collected through the probe)

| # | Scenario | Failure prevented | Anchor |
|---|---|---|---|
| P1 | A 300 ms first-token delay, then about 3 s at 100 tok/s with `usage.output`. During streaming, the `pi-tps:status` snapshots of the last second carry `liveTps` within the D4 band, and `ttftMs` stays frozen once the first token has arrived. The record has `tps` within the D4 band, `ttftMs` of at least 300, and `outcome: "settled"`. A `pi-tps` custom entry and a `pi-tps:run` payload with the same request are written. | A readout that shows no or the wrong live speed, reports the wrong settled speed, or loses the run | request-measurement: Time to first token, Live output TPS over a sliding window, Settlement from provider usage. telemetry-history: Telemetry is persisted per run, Telemetry records are broadcast |
| P2 | 2 s of streamed thinking, then text, with `usage.reasoning`: `thinking: "streamed"`, `thinkingMs` of at least 1.8 s, TPS over thinking plus output time. Hidden thinking (start and end events, no deltas): `thinking: "hidden"`. | Thinking time folded into TTFT or dropped from TPS | request-measurement: Thinking and output are measured separately |
| P3 | A buffered flush after a silence is `burst: true`, and in the following idle `pi-tps:status` snapshot for that model `average.burstTps` is present and `average.tps` is absent. A 1.5 s mid-stream pause is one stall, with TPS still inside the band. | Proxy buffering or network stalls corrupting the averages | request-measurement: Burst detection, Stall detection, Burst requests do not feed calibration or TPS aggregates |
| P4 | TUI mode, footer history through `ui.status("pi-tps")` with ANSI stripped. During the request the line starts with a spinner frame and shows `TTFT`. After streaming starts it shows `TPS`. When idle it starts with `✓` and shows `1 run in` and `↓`. Escape (`session.abort()`) mid-stream gives a `✗` line and an `outcome: "aborted"` record. `/tps` clears the line and `/tps` again restores it. In RPC mode pi-tps never calls `setStatus`, yet still emits `pi-tps:status`. | A broken or stuck footer, or footer writes in non-TUI modes | tps-readout: Readout phases, Idle readout shows session totals, /tps command toggles visibility, Non-TUI modes write nothing to the UI. request-measurement: Aborted requests |
| P5 | File-backed session with two runs; then `reopen()`. The idle snapshot, requested via `pi-tps:request`, reports `session.runs === 2` and a TPS average. `session.navigateTree` back to the first run's last entry reports `session.runs === 1`. With `persist: false`, a reopened session reports no session totals. | History lost on resume or `/reload`, or totals that do not follow the branch | telemetry-history: Reconstruction on session start and branch change, Persistence can be disabled |
| P6 | Pi's built-in retry enabled with a short delay. The first request errors and the retry succeeds: one run, one request record, no record for the error. | Errored attempts inflating request counts or ending the run early | request-measurement: Errored and deferred requests, A run spans one agent run until Pi settles |
| P7 | The provider reports a serving model different from the selected one. The record names the serving `model` and `requested`, and calibration is stored under the serving model, not the selected one. Then `session.setModel` to a second scripted model while idle: the idle snapshot's `average` switches to that model's (empty) averages. | Virtual-model traffic attributed to the wrong model, or an idle readout showing another model's averages | telemetry-history: Records name the selected model. token-estimation: Model identity. tps-readout: Averages follow the current model |
| P8 | Session A settles a calibrating request where `usage.output` is about twice the estimate. The calibration directory then holds a snapshot with a ratio near 2. Session B (a new runtime, same agent dir) streams the same scripted response as A's first request, and its streaming `pi-tps:status` snapshot at the same point reports about twice A's live `outputTokens` (between 1.5× and 2.5×), with no internal estimator call. Two worker processes concurrently settle N calibrating requests each against one agent dir: the newest snapshot accounts for all 2N samples. With `calibration: false`, the directory is never created. | Calibration not persisting, concurrent sessions overwriting or double-counting samples, or writes despite opting out | token-estimation: Calibration persists across sessions, Calibration is shared by concurrent sessions, Calibration can be disabled |
| P9 | The README's example configuration, extracted from the fenced block after its marker comment, loads with no warnings. A config with one invalid field gives one warning and the readout still renders. | Documentation that does not load, or a bad config disabling the readout | tps-configuration: Validation and fallback |

#### Release tooling (CLI processes, real git, real pnpm, `gh` stub, local registry)

| # | Scenario | Failure prevented | Anchor |
|---|---|---|---|
| L1 | A branch that changes `packages/pi-a/src` without an intent fails `cli.ts coverage` and names `@zeroclover/pi-a`. Adding a `pnpm change --bump patch` intent passes. A reasoned `--bump none` passes. A change limited to `test/` and `openspec/` passes without an intent. A hand-edited `version` in a plugin manifest without a preparation fails. | Plugin changes merging without a release decision, or versions changed outside preparation | package-releases: PRs declare their own release impact, Default-branch publication uses the prepared records |
| L2 | A preparation made by `pnpm version -r` and integrated as a squash commit of a merged PR (`gh` stub): `cli.ts plan --event push` reports a release of that source commit, its first parent, the pull request, and the member keys. A docs-only push is a no-op. A forced push of records, a record pushed without a merged PR, a preparation that also carries a hand-edited version of another plugin, and a preparation hidden behind a later commit of the same push are all refused. | Publishing anything that did not pass the reviewed PR boundary | package-releases: Default-branch publication uses the prepared records, Preparation must not stack unpublished versions. agent-release-workflow: Preparation uses a constrained PR integration protocol, A reviewed merge is the publication boundary |
| L3 | `cli.ts verify` packs, installs, and loads the plugin in Pi and writes `batch.json`. `cli.ts publish` uploads to the local registry, creates the tag and the release through the `gh` stub, and the release notes are the version's CHANGELOG section. Rerunning `publish` uploads nothing and creates nothing. A registry lookup answered with a 500 fails the run with no upload. An upload that succeeds while `gh release create` fails once leaves a nonzero exit, and the rerun uploads nothing and only creates the release. A tag that points elsewhere fails the run without being moved. A tarball altered after `verify` is refused before any upload. | Publishing unverified bytes, double publication on retry, a release left half-announced, an outage read as "not published", a release announced with notes other than the reviewed changelog, or rewriting a tag | package-releases: Validate the actual installable package, Release descriptions come from reviewed prose, Tags record package versions after publication, Retry the original batch without new version decisions, Recover using only the original release SHA |
| L4 | `cli.ts preflight` on a PR head that adds a record for a plugin whose entry throws at load fails and names it. One whose tarball would ship a host package in `dependencies` fails too. A head without new records is a no-op. | A broken artifact reaching the default branch | package-releases: Preflight preparation artifacts before merge |
| L5 | A revert of an unpublished preparation is accepted as a withdrawal. A withdrawal after an upload is refused. Re-adding a withdrawn record does not regain publishing authority. | Silently unpublishing, or resurrecting a withdrawn release | package-releases: Withdraw a failed preparation only before uploads, A withdrawn preparation cannot regain publishing authority |

`tools/release/test/load.test.ts` stays unchanged and covers change-verification: The workspace check loads every extension. It calls the exported `loadCommands` helper instead of the CLI because that requirement says the workspace load and release verification must share one load implementation. It tests packages, not the release tooling, and is the only test allowed to import from `src/`.

### D7. Deliberately not covered

| Behavior | Why no end-to-end test |
|---|---|
| pi-tps live-TPS window internals: the 5 s window, 300 ms backlog windows, proration at the window edge, resume-after-pause thresholds, the 1.5 s visibility rule | Sub-second arithmetic whose exact figures are not a user contract. Reproducing it through a session needs injected clocks, which D4 forbids. P1 checks that the live rate is shown and roughly right on a steady stream, and P3 that stalls and flushes do not distort the settled rate. A visible misreading gets an end-to-end reproduction when it is reported. |
| pi-tps smoothing constants, number-format edge cases, estimator chunk stability, exact README example lines | Values computed by the code itself, so a test would restate the implementation. P4 and P9 cover that the readout renders and the config loads. |
| pi-tps colour bands and the override precedence ladder | A user-facing contract, but cosmetic: a regression shows a wrong colour, never a wrong figure, and is obvious on sight. Checking it end to end means asserting ANSI colour per segment under several configs, which costs more than the failure. |
| pi-tps exclusion of requests outside a turn (cache warming, compaction, tool-made model calls) | In Pi 1.1 only requests that carry the agent loop's stream options (the loop's own requests, and cache-warming replays of them) carry the payload hook that emits `before_provider_request`: the `Agent` adds `onPayload` to its loop config (`pi-agent-core` `dist/agent.js`), while compaction and branch summaries call `agent.streamFunction` directly with their own options and no `onPayload` (`dist/core/compaction/compaction.js`). Verified in the spike: a manual `session.compact()` made two provider calls, neither carried `onPayload`, and `before_provider_request` fired zero times. Compaction therefore leaves nothing for pi-tps or a test to observe. Cache-warming refreshes do pass through it, but Pi schedules them from the model's cache lifetime (minutes) and an estimated saving, so a test cannot trigger one on demand within its budget. Model calls made by tools would need another extension that makes its own model requests, which no package here does. |
| pi-tps use of a monotonic clock | A wall-clock jump could be simulated by replacing the global `Date.now`, but Pi's own scheduling and the harness share that global, so the test would perturb what it observes. The guarantee is the one-line choice of `performance.now` in `src/clock.ts`; the regression risk is low and accepted. |
| pi-tps calibration race sub-cases (reused version numbers, 7-day record expiry, a session paused beyond retention, unwritable directory) | Need fault injection into the file system or weeks of clock time. P8 covers the guarantee that matters: concurrent sessions do not lose or double-count samples. |
| pi-rtk automatic recheck of an unavailable `rtk` after 30 s (`RECHECK_MS`), the only recovery when `rtk` is installed mid-session without `/rtk on` | Each run would wait 30 s, and the clock is not exposed to an end-to-end test without changing product code. K4 covers the explicit recovery through `/rtk on`. |
| pi-rtk Windows default-shell rule, cancellation during `rtk rewrite`, the internal-error guard | The platform branch cannot run on POSIX CI. Cancellation within a 2 s window is timing-fragile and low-risk. The guard has no reachable trigger without breaking Pi. |
| pi-retry's further variants of one provider family, HTTP-date and epoch `retry-after` variants, jitter distribution, RPC-client abort, the two-responses gate closure | R3 keeps one real text per category and per provider family, plus the documented traps. Further variants within a family are data; a misfiring provider text gets a row via the bug-fix rule. The rest is internal arithmetic or behavior pi-retry cannot observe. |
| Release parsers' formatting tolerance (CRLF, BOM, YAML flow style, quoting) and `gh` response-shape variants | Real pnpm and the `gh` contract define the inputs. Tolerance for formats nobody writes adds no protection. |

### D8. Time budget and runner configuration

- Target: the full `pnpm test` under two minutes wall time on the CI runner, with the slowest single scenario under 30 s. The default per-test timeout is 30 s, and 60 s for release scenarios that install and load in Pi.
- `vitest.config.ts` keeps the `include` globs and sets `pool: "forks"`, so every file has its own process and `process.env`. It also sets the timeouts above. Files run in parallel, and scenarios inside a file run one after another.
- Scripted delays are kept to the minimum that makes each behavior observable: about 3 s of streaming for rate scenarios, 100 ms backoff for retries, and 5 s only where a wait must be interrupted.

### D9. Documentation

- `docs/conventions.md` "Tests": tests are end-to-end through `tools/e2e` or the release CLI; no runtime imports of a package's `src/` (type-only imports of documented payload types are allowed); never fabricate Pi's extension events or `pi`/`ctx` objects (the scripted provider's stream events are the model double); name the failure and the spec requirement; time assertions use bands; a bug fix adds a failing end-to-end reproduction.
- `docs/architecture.md`: the layout gains `tools/e2e/`. The package anatomy describes `test/` as end-to-end scenarios. The rules no longer justify a thin `index.ts` by testability: it stays thin for readability, and the "gets unit tests under `test/`" sentence goes.
- `docs/workflow.md`: the new-package template replaces `greeting.test.ts` with an end-to-end test that calls the `hello` tool through a scripted provider and runs `/hello`. "Verify" names the end-to-end suite. "Change an existing extension" step 3 says "with its end-to-end scenario".
- `docs/releases.md` "Tooling" (line 218) describes the CLI-level tests. The `pi-extension-dev` skill, step 5, drops "logic in separate modules with tests" in favour of the end-to-end rule.
- `packages/pi-tps/README.md`: the `example-lines` comment is removed, because the exact lines are no longer checked. The `example-config` comment is reworded to name the new test file.

## Risks / Trade-offs

- [Flaky timing on slow CI runners] → D4 bands; streams of no more than a few seconds; no upper bounds without a 1 s margin. A flaky scenario is fixed by widening its band or rewriting it, never by retrying the test.
- [Fine-grained regressions in measurement arithmetic are no longer caught early] → Accepted, as listed in D7. The real-stream scenarios catch errors large enough to mislead a user. Smaller ones get an end-to-end reproduction under the bug-fix rule.
- [The harness depends on Pi's SDK surface (`createAgentSessionRuntime`, `createProvider`, `Theme`)] → It uses only public exports. Breakage on a Pi upgrade is the signal this change wants: the extensions depend on the same surface.
- [The registry double may not accept `pnpm publish`] → D5 spells out what the double must do. If it still cannot be made to work, the implementer stops and the change is revised; there is no silent fallback.
- [`pnpm check` gets slower] → D8 budget. CI parallelises across files.
- [Concurrency scenario P8 needs worker processes] → The worker is a small script in `packages/pi-tps/test/` that uses the harness. It runs under Node's built-in type stripping, as `tools/release/src/cli.ts` already does.

## Migration Plan

All in one pull request, ordered harness first, then one package at a time (tasks.md). For each package, its old tests are deleted in the same task group that adds its scenarios, so the tree never has both styles for one package. Rollback is a revert of the pull request. No published behavior changes.
