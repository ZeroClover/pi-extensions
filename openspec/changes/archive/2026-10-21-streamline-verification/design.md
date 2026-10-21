# Design

## Context

Feature verification (`docs/workflow.md`, "Verify") lists `pnpm check`, a manual RPC load test, live checks, and a local run of the release-impact gate. CI on pull requests runs `pnpm check`, `pnpm change check`, and the gate, but no load. Release verification (`cli.ts verify`) packs, inspects, installs, and loads each batch member, but only in the release workflow after the preparation is merged.

## Goals / Non-Goals

**Goals:**
- Every check that can be automated runs in CI before merge; local verification keeps only what gives faster feedback than CI or cannot run there.
- One load implementation shared by the workspace test, the preflight, and release verification.

**Non-Goals:**
- Changing what release verification checks after merge; it still re-verifies the release commit independently.
- Removing local `pnpm check` (about ten seconds, and it avoids a CI round trip) or the live checks CI cannot perform.
- Comparing workspace commands with expected command lists; the load test proves that each extension loads.

## Decisions

### The load test is a Vitest test

`tools/release/test/load.test.ts` starts the root `node_modules/.bin/pi` once per `packages/*` directory with `-ne -e <dir> --mode rpc`, an empty `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, and a working directory outside the workspace, through the same `loadCommands` helper that release verification uses (now exported). Running inside `pnpm check` puts it into every local verification and both CI workflows without a new CI step or a second command to remember. Alternative: a CI-only step; rejected because the local manual step would remain.

### The preflight reuses the release batch reader

`ReleaseRepository.readBatch(source, parent?)` takes an optional parent; the preflight passes the merge base of the pull request base and the checked-out head, so validation, publication order, and the unprepared-version check are the same as for a release. `verifyRelease` and the new `preflightRelease` share one pack-then-install-and-load routine; only `verifyRelease` writes `batch.json`. A pull request without new release records (or with a withdrawal) is a successful no-op. The CI step runs on the checked-out merge commit, which is what would be merged.

### Documentation states scope instead of adding steps

The workflow's "Verify" section says it applies to source changes and that a release preparation is verified by its §2 review plus CI. The local gate becomes an optional debugging aid.

## Risks / Trade-offs

- [The preflight installs runtime dependencies from the registry in PR CI] → Same behavior and network dependency as release verification; it only runs when a pull request adds release records.
- [A transient registry failure blocks a preparation PR] → Rerun the job; nothing is published from pull requests.
- [The load test adds Pi startup time to `pnpm check`] → Measured under two seconds per package offline.
