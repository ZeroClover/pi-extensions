# change-verification Specification

## Purpose
What verifies a change before it is done: which checks run locally, which only in CI, and how release preparations are verified.

## Requirements

### Requirement: The workspace check loads every extension

`pnpm check` SHALL load every package under `packages/` in the repository's installed Pi host without a model call, with an empty agent directory, offline, and from a working directory outside the workspace. A package that fails to load SHALL fail `pnpm check`, so the same load runs locally and in CI on every pull request and default-branch push.

#### Scenario: An extension that does not load
- **WHEN** a package's entry point throws or imports a missing module at load time
- **THEN** `pnpm check` fails and names the package
- **AND** the pull request's required `Check` fails without any separate load step

#### Scenario: A new package
- **WHEN** a pull request adds `packages/<name>/`
- **THEN** the load test covers it without configuration

### Requirement: Local verification does not repeat CI-only gates

The documented verification for a change SHALL require `pnpm check` and, for behavior that needs a live session, a live check. It SHALL NOT require running the release-impact gate locally; CI runs it on every pull request. Running it locally SHALL remain documented as a debugging aid against the remote default branch.

#### Scenario: Agent finishes a source change
- **WHEN** an agent verifies a source change before opening a pull request
- **THEN** it runs `pnpm check` and any live checks, and relies on the pull request's CI for the release-impact gate

### Requirement: Release preparations are verified by review and CI

A release preparation pull request SHALL be verified by the review that `docs/releases.md` prescribes (plan, versions, records, intents, and changelog prose) and by CI. The source-change verification steps (local `pnpm check`, live checks) SHALL NOT be required for it.

#### Scenario: Agent prepares a release
- **WHEN** an agent applies `pnpm version -r` and opens the preparation pull request
- **THEN** it reviews the generated files as `docs/releases.md` §2 requires and does not run live extension checks
- **AND** CI runs `pnpm check` and the artifact preflight on that pull request

### Requirement: Extensions are tested in a real Pi session

Tests of an extension SHALL run a real Pi session that loads the extension from its package directory. Only the model provider, the terminal, programs outside the repository, and the tools of third-party extensions the package adapts to may be replaced by scripted doubles. The workspace load check is governed by "The workspace check loads every extension" and is exempt from this and the following requirements.

#### Scenario: Testing an extension behavior
- **WHEN** an agent adds a test for a tool rewrite, a retry, a readout, or any other extension behavior
- **THEN** the test starts a Pi session with the package loaded from `packages/<name>/` and a scripted provider
- **AND** it asserts only on what the session exposes: tool results, the requests the provider receives, notifications, status text, session entries, event-bus payloads, and files the extension writes

#### Scenario: Behavior-neutral refactor
- **WHEN** an agent restructures a package's `src/` modules without changing what the session observes
- **THEN** no test needs to change

### Requirement: Extension tests do not reach into internals

Extension tests SHALL NOT import a package's `src/` modules, except type-only imports of payload types the package documents as public. They SHALL NOT hand-build Pi's extension events (the payloads Pi delivers to `pi.on` handlers) or fake `pi`/`ctx` objects. The scripted provider's stream events, and messages sent on event-bus channels the package documents as inputs, are allowed.

#### Scenario: Asserting on a computed value
- **WHEN** a test needs the figure an extension computed, such as a request's TPS
- **THEN** it reads the figure from what the extension publishes (an event-bus payload, a session entry, or status text), not by calling the module that computes it

### Requirement: Release tooling is tested through its CLI

Tests of the release tooling SHALL run `tools/release/src/cli.ts` as a process against temporary git repositories whose release files are written by real pnpm commands. GitHub and the npm registry SHALL be replaced only at the process boundary.

#### Scenario: Testing a release check or publication step
- **WHEN** an agent adds a test for a release check or publication step
- **THEN** the test runs the CLI command in a temporary git repository, with intents, ledger, and changelogs produced by `pnpm change` and `pnpm version -r`
- **AND** GitHub is answered by a stub `gh` executable and the registry by a local HTTP double

### Requirement: Each test names the failure it prevents

Every end-to-end test SHALL state, in its name or an adjacent comment, the user-visible failure it guards against, and SHALL reference the package or repository spec requirement it covers. A test SHALL NOT be added only to raise coverage or to restate a value that the code under test computes.

#### Scenario: Reviewing a new test
- **WHEN** a reviewer reads a test added by a change
- **THEN** they can tell which spec requirement it covers and which broken behavior would make it fail

#### Scenario: A proposed test with no user-visible failure
- **WHEN** a test could only fail because an internal function's output changed while the session observes the same behavior
- **THEN** the test is not added

### Requirement: End-to-end tests run offline and deterministically

The tests that `pnpm check` runs SHALL need no network access, credentials, or model calls, and SHALL pass on CI runners that do not have optional external tools installed. Assertions on time-dependent figures SHALL use bounds wide enough to absorb scheduler delay on a slow runner. A test that checks a contract with an optional external tool SHALL be skipped when that tool is absent, and SHALL say so.

#### Scenario: CI without rtk
- **WHEN** `pnpm check` runs on a CI runner without `rtk`
- **THEN** every pi-rtk scenario passes against a temporary fake `rtk`, and the contract check against the real `rtk` is reported as skipped

#### Scenario: A slow runner
- **WHEN** the runner delays timers by tens of milliseconds
- **THEN** rate and duration assertions still pass, because they check bands and ordering rather than exact values

### Requirement: A bug fix is reproduced end to end

A change that fixes a bug observable through a Pi session or the release CLI SHALL add or extend an end-to-end test that fails without the fix and passes with it.

#### Scenario: Fixing a misclassified provider error
- **WHEN** an agent fixes pi-retry so that a provider's error text is retried
- **THEN** the change adds that error text to the end-to-end classification scenario, and the scenario fails on the code before the fix
