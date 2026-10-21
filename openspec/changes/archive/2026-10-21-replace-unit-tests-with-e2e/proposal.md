# Proposal

## Why

The repository carries about 9,100 lines of tests for 7,900 lines of source, and almost all of them test internal modules in isolation: hand-built Pi event payloads, fake `pi`/`ctx` objects, injected clocks, a fake `rtk` function, and hand-written copies of the files pnpm writes. They pin implementation details, so a behavior-neutral refactor breaks dozens of them. They also miss the failures that matter, which sit at the contracts with Pi, pnpm, rtk, and the registry. For example, pi-tps only measures a request if Pi emits `before_provider_request`, and that event comes from the provider's `onPayload` hook (verified, see design.md). No unit test can observe that dependency, because each one feeds the measurement code the event directly. The test count has become a stand-in for confidence it does not provide.

## What Changes

- Delete every unit test and its fixtures: all of `packages/pi-retry/test/`, `packages/pi-rtk/test/`, `packages/pi-tps/test/`, and `tools/release/test/` except `load.test.ts`, which already loads every package in the real `pi` binary and stays as is.
- Add a shared end-to-end harness under `tools/e2e/` (root development tooling, never published or loaded by Pi). It runs a real Pi session runtime in process, loads the extension from its package directory the way `pi -e` does, and replaces only what lies outside the system under test: the model provider (a scripted provider that keeps Pi's real request hooks and streaming timing), the terminal (a recording UI), and external programs (temporary executables on `PATH`).
- Replace each package's tests with a small set of end-to-end scenarios. Each one names the user-visible failure it prevents and the package spec requirement it covers. The catalogue, and the list of behaviors deliberately left uncovered with reasons, are in design.md.
- Replace the release tooling's unit tests with end-to-end runs of `tools/release/src/cli.ts` in temporary git repositories. Release files are produced by real `pnpm change` and `pnpm version -r` instead of hand-written fixtures, and GitHub and the npm registry are replaced by local doubles at the process boundary.
- Change the testing convention so new work follows it. Tests drive a real session or the real CLI, and a bug fix adds an end-to-end reproduction that fails before the fix. Update `docs/conventions.md`, `docs/architecture.md`, `docs/workflow.md` (including the new-package template), `docs/releases.md`, and the `pi-extension-dev` skill to match.
- No package behavior changes and no `src/` file changes. The only published-content edit is two HTML comments in `packages/pi-tps/README.md` that name deleted test files. It carries a `none` release decision.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `change-verification`: adds requirements on what a test must be (an end-to-end check of observable behavior through a real Pi session or the real release CLI, offline, naming the failure it prevents) and on reproducing a bug end to end before fixing it. The existing load requirement is unchanged.

## Impact

- Affected packages: `pi-retry`, `pi-rtk`, `pi-tps`. Only their `test/` directories change, plus the two README comments in `pi-tps`. Their behavior and their `openspec/specs/` stay as they are, so no package-scoped change is needed. The work is repo-wide for three reasons. The testing convention is a repository rule in `docs/conventions.md`. The harness is shared root tooling that every package's tests use. Converting packages one at a time would leave the convention contradicting the code in between and would design the same harness three times.
- Root tooling: a new `tools/e2e/`, a rewritten `tools/release/test/`, and `vitest.config.ts` (test timeout, process isolation). `tsconfig.json` already covers `tools/*/src` and `tools/*/test`.
- Docs: `docs/conventions.md`, `docs/architecture.md`, `docs/workflow.md`, `docs/releases.md`, `.agents/skills/pi-extension-dev/SKILL.md`.
- Runtime: `pnpm check` gets slower, because the scenarios stream with real timing. The target is under two minutes wall time on CI (design.md, "Time budget").
- Dependencies: none added. The harness uses Pi's public SDK exports, and the registry double uses `node:http`.
- Release: one `pnpm change --bump none` intent for `@zeroclover/pi-tps`, for the README comment edit.
