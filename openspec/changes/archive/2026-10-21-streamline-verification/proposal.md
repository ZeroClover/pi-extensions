# Proposal

## Why

The documented verification makes agents repeat a CI-only gate locally and, read literally, run feature verification on release preparations that change no source. At the same time, two checks happen too late or only by hand: no pull request check loads the extensions in Pi, and a preparation's packed artifacts are first built and loaded after its merge, when a failure can only be undone by a withdrawal.

## What Changes

- `pnpm check` loads every workspace extension in the installed Pi host without a model call, so the load test runs locally and in CI on every pull request and push instead of being a separate manual step.
- CI runs a new read-only artifact preflight on pull requests that add release records: the same pack, tarball inspection, isolated install, and load that release verification performs, against the pull request's merge base. A broken artifact now fails the preparation pull request before merge.
- The local release-impact gate run is removed from the documented verification; CI runs it on every pull request. Running it locally stays possible for debugging, against `origin/master`.
- Release preparation pull requests are verified by the review in `docs/releases.md` §2 and by CI; the feature verification section does not apply to them.
- `AGENTS.md`, `docs/workflow.md`, `docs/releases.md`, the `pi-extension-dev` skill, and the OpenSpec configurations that name the verification steps are updated to match.

## Capabilities

### New Capabilities
- `change-verification`: what verifies a change before it is done, and which checks are local, CI-only, or not applicable to release preparations.

### Modified Capabilities
- `package-releases`: adds "Preflight preparation artifacts before merge", the pull request counterpart of "Validate the actual installable package".

## Impact

- Repository-wide: `tools/release/` (a shared load helper, a `preflight` command, a workspace load test), `.github/workflows/ci.yml`, root docs, `AGENTS.md`, the skill, and `openspec/config.yaml`.
- Packages: only `packages/*/openspec/config.yaml`, whose verification text names the old steps. No published package content changes, so no release decision is needed.
- `pnpm check` takes a few seconds longer (one offline Pi start per package).
