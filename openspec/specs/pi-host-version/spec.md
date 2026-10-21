# pi-host-version Specification

## Purpose
Which Pi release the repository develops, verifies, and documents extensions against, when that target moves, and what extensions owe older Pi releases.

## Requirements

### Requirement: The target is Pi's latest stable release

The repository SHALL have no fixed Pi baseline. Its target SHALL be the version of `@earendil-works/pi-coding-agent` that the npm `latest` dist-tag names at the time of the work. Prereleases and other dist-tags SHALL NOT become the target.

#### Scenario: Pi publishes a new stable release
- **WHEN** the `latest` dist-tag of `@earendil-works/pi-coding-agent` moves from 1.3.0 to 1.4.0
- **THEN** 1.4.0 is the target for all extension work from then on, without any change to the repository's documented rules

#### Scenario: A prerelease or legacy tag
- **WHEN** Pi publishes a prerelease, or the `legacy-node20` dist-tag names a version
- **THEN** the target stays the version the `latest` dist-tag names

### Requirement: The workspace host matches the target exactly

The root `devDependencies` SHALL pin `@earendil-works/pi-coding-agent` to the target version, and `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, and `typebox` to the exact versions the target release depends on, and the lockfile SHALL resolve them to those versions. These host packages SHALL be upgraded only together.

#### Scenario: A host dependency has a newer release of its own
- **WHEN** `typebox` publishes 1.4.2 while the target Pi release depends on `typebox` 1.3.27
- **THEN** the root keeps `typebox` at 1.3.27

#### Scenario: Reading the target from the repository
- **WHEN** an agent reads the root `package.json`
- **THEN** the `@earendil-works/pi-coding-agent` entry states the exact version the workspace develops against, and `node_modules/@earendil-works/pi-coding-agent/` holds that version's docs, examples, and types

### Requirement: Extension work starts on the current target

Before creating, changing, or debugging an extension, an agent SHALL compare the root host version with the version the `latest` dist-tag names. When the root is behind, the agent SHALL upgrade the host before the extension work and SHALL NOT develop or verify the extension against the older host.

#### Scenario: Pi released since the last upgrade
- **WHEN** an agent starts a pi-retry fix while the root pins Pi 1.3.0 and the `latest` dist-tag names 1.4.0
- **THEN** it upgrades the host to 1.4.0 first, and develops and verifies the fix against 1.4.0

#### Scenario: Already current
- **WHEN** the root pins the version the `latest` dist-tag names
- **THEN** the agent proceeds with the extension work without an upgrade

#### Scenario: Registry unreachable
- **WHEN** the registry lookup fails, for example in an offline or sandboxed session
- **THEN** the agent proceeds on the pinned host and states in its report that the target could not be confirmed

### Requirement: A host upgrade needs no proposal

An agent that finds the root host behind the target SHALL perform the upgrade itself as part of the task that found it, without an OpenSpec proposal and without a separate request from the user. A package fix the upgrade requires SHALL go through that package's OpenSpec workflow only when it changes the package's user-visible behavior.

#### Scenario: Routine upgrade
- **WHEN** an agent starting extension work finds the root at Pi 1.3.0 and the `latest` dist-tag at 1.4.0
- **THEN** it upgrades the host in its own pull request without creating an OpenSpec change, and the user reviews that pull request like any other

#### Scenario: The upgrade forces a behavior change
- **WHEN** Pi 1.4.0 removes an API so that a package can no longer offer one of its settings
- **THEN** the package change is proposed from that package's OpenSpec root before it is made, and the host bump waits for it

### Requirement: An upgrade leaves every package working on the new target

A host upgrade SHALL review the changelog of every Pi release between the old and new versions, SHALL pass `pnpm check` on the new host, and SHALL re-verify Pi-version-dependent statements in package READMEs and specs. A package that breaks or whose documented facts change SHALL be fixed in the same upgrade, with its own release decision.

#### Scenario: An upgrade breaks an extension
- **WHEN** Pi 1.4.0 renames an event that pi-tps listens to, and `pnpm check` fails after the bump
- **THEN** the upgrade adapts pi-tps to the new event, records a release decision for `@zeroclover/pi-tps`, and is complete only when `pnpm check` passes

#### Scenario: A documented fact names the old version
- **WHEN** a package README describes Pi's behavior "as of Pi 1.1" and the host moves to 1.3.0
- **THEN** the upgrade checks the statement against 1.3.0 and updates it, or its version label, to match

### Requirement: Extensions do not support older Pi releases

Extension code SHALL use the target's API and SHALL NOT carry fallbacks, feature detection, or shims for Pi releases older than the target. Host packages SHALL remain `"*"` peers; no package SHALL declare a minimum Pi version.

#### Scenario: An API changed in the target release
- **WHEN** the target release changes an event payload that an extension reads
- **THEN** the extension reads the new payload only, and does not branch on the older shape

### Requirement: CI does not check the host against the registry

CI SHALL install the host from the frozen lockfile and SHALL NOT compare it with the registry. A Pi release SHALL NOT change the outcome of a CI run on an unchanged commit.

#### Scenario: Pi releases while a pull request is open
- **WHEN** Pi publishes a new stable release after a pull request's checks passed
- **THEN** re-running CI on the same commit gives the same result, and the upgrade happens in the next extension task
