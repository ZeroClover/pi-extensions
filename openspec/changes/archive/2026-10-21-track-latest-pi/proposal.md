# Proposal

## Why

The repository develops against a fixed Pi baseline: the root `devDependencies` hold the host packages at `^1.1.0`, the lockfile resolves them to 1.1.0, and `docs/workflow.md` tells agents to keep them at whatever `pi` happens to be installed. Pi 1.3.0 is the current stable release, so agents read 1.1.0 docs, types, and examples and verify against a host that users have already left behind. Extensions are meant to evolve with Pi, not stay on the version they were written for; the target has to be whatever Pi's latest stable release is at the time of the work.

## What Changes

- The fixed baseline is removed. Extension development, maintenance, and verification always target Pi's latest stable release, defined as the npm `latest` dist-tag of `@earendil-works/pi-coding-agent`. The other host packages (`pi-ai`, `pi-tui`, `pi-agent-core`, `typebox`) follow the exact versions that release depends on, not their own `latest` tags.
- The root host `devDependencies` are pinned to those exact versions, so `package.json` states the current target. This change moves them to Pi 1.3.0 (`typebox` stays at 1.3.27, which Pi 1.3.0 depends on).
- Every extension task starts by checking the target against the registry; when Pi has a newer stable release, the host is upgraded first. The upgrade procedure covers every skipped version's changelog, `pnpm check`, package fixes with their own release decisions, and re-verification of version-dependent statements in package docs.
- A host upgrade is routine maintenance: the agent that finds the target behind performs it without an OpenSpec proposal and without waiting for a separate request. This change is the only proposal the policy needs; later upgrades are reviewed as ordinary pull requests.
- Extensions carry no compatibility code for older Pi releases. Host peers stay `"*"`, and the root README states that extensions are developed against the latest stable Pi.
- The rule "keep the host at the installed `pi` version" is removed: live checks run the workspace's Pi (`pnpm exec pi`), so the globally installed `pi` no longer decides the target.
- CI keeps installing from the frozen lockfile and does not query the registry, so a new Pi release never fails an unrelated pull request.
- `AGENTS.md`, `docs/workflow.md`, `docs/pi-reference.md`, `docs/releases.md`, the `pi-extension-dev` skill, and the root README are updated to match.
- `packages/pi-tps/README.md` labels its provider-adapter table "(Pi 1.1)"; the table is re-verified against Pi 1.3.0 and relabelled.

## Capabilities

### New Capabilities
- `pi-host-version`: which Pi release the repository develops and verifies against, when and how that target moves, and what extensions owe older releases.

### Modified Capabilities

None. `change-verification` already refers to "the repository's installed Pi host", which this change defines; its requirements do not change.

## Impact

- Repository-wide, because the host version is shared tooling: root `package.json` and `pnpm-lock.yaml`, `AGENTS.md`, `docs/`, the `pi-extension-dev` skill, and the root README. A trial upgrade to 1.3.0 passed `pnpm check` (lint, typecheck, 55 tests in 18 files, every package loaded in the 1.3.0 host) without code changes.
- Packages: no source changes. `pi-tps` gets a README edit, which is published content and needs a `none` release decision. `pi-retry`, `pi-rtk`, and `pi-tps` code is unchanged; their host peers remain `"*"`.
- Archived OpenSpec changes that mention Pi 1.1.0 are history and stay as they are.
