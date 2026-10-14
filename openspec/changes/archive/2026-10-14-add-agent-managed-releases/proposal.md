# Proposal

## Why

The workspace needs to publish changed Pi plugins independently without delegating release scope, versions, or user-facing prose to CI. Native pnpm changesets already express release intent; a second manual tag-based selection step duplicates that decision and adds unnecessary tooling.

## What Changes

- Use pnpm's native change intents and local version preparation, with committed per-package changelogs and the native consumption ledger. Keep versions independent and do not add a separate version manager.
- Make a positive changeset the declaration that a plugin should ship. Agents author its prose and bump choice, prepare all pending packages or a native-filtered subset locally, review exact versions and final notes, and submit the result for review. Unselected packages retain their pending intent; CI publishes the complete prepared batch without a second package-selection step. No positive intent means no release; explicit no-release declarations do not select a package.
- Publish a reviewed preparation PR through one Squash or Merge integration commit on the protected default branch. CI reads new ledger keys relative to that commit's first parent and publishes from its final reviewed snapshot. Compare push-endpoint ledger records to recognize release no-ops; otherwise enforce the first-parent boundary before deriving a batch. Do not reconstruct batches across pushed history or classify source paths. CI never prepares versions or generates prose from commits.
- Always name plugin npm packages @zeroclover/<package_name>. The first package becomes @zeroclover/pi-tps while its directory stays packages/pi-tps/. Update naming conventions and templates accordingly during implementation.
- Create package-specific Git tags and GitHub Releases after registry availability is confirmed. Tags record the exact source commit; they neither trigger publication nor establish a shared monorepo version. Two independently versioned packages can have different tags pointing to the same commit.
- Add a focused PR release-impact gate, existing quality checks, actual packed-package inspection, and isolated Pi load verification. Keep retries to existing-version skipping, native availability waiting, and creating missing announcements from the original release snapshot. Keep a minimal recovery dispatch accepting only the original release SHA, with its first parent as the fixed baseline. Every publishing entry point checks ledger-only authorization continuity through the current default branch, so withdrawal cannot be undone by recreating the same version key. Never scan historical records for publication targets or retarget releases to a later checkout.
- Document pnpm's registry-dependent first-release behavior and prohibit stacked unshipped preparations. Allow a reviewed forward revert-and-redo only when the entire batch has never entered upload and old runs are stopped; never undo published or uncertain uploads. Keep the custom recovery state machine and upstream pnpm regression suite out of scope.
- Update the shared agent rules, extension-development skill, runbook, templates, and installation documentation as implementation tasks.

## Capabilities

### New Capabilities

- `package-releases`: Scoped, independently versioned packages; changeset-driven local preparation; default-branch publication of a committed release batch; package-level notes and release records.
- `agent-release-workflow`: Shared instructions for authored release intent, scope conventions, safe preparation, review/merge authority, and evidence-based release reporting.

### Modified Capabilities

None. No existing repository-level capability is modified, and package runtime specifications are unchanged.

## Impact

- Repository-wide policy and tooling apply to every packages/* member. pi-tps is the initial naming, packaging, and smoke-test target; its extension behavior, commands, settings, and package-scoped OpenSpec root remain unchanged.
- Expected implementation surfaces: pnpm-workspace.yaml, root tooling scripts/configuration only where needed, .changeset/, GitHub Actions, and minimal repository-specific validation with focused tests. The root stays private and holds no extension runtime code.
- Documentation work includes AGENTS.md, .agents/skills/pi-extension-dev/SKILL.md, docs/releases.md, relevant existing docs, root README.md, and package README/manifests. Package directories use the unscoped basename; registry identities and changeset keys use the full scoped name. CLAUDE.md remains exactly @AGENTS.md.
- The publication namespace is @zeroclover. The repository URL, license, registry access, and trusted-publisher/first-publish setup remain owner-controlled activation inputs; choosing the scope does not prove credentials are configured.
