## ADDED Requirements

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
