# Tasks

## Activation inputs and boundaries

Package identity: every plugin uses @zeroclover/<package_name>; pi-tps becomes @zeroclover/pi-tps without moving packages/pi-tps/.

Before any real publication, the owner must supply or confirm:
- The actual GitHub repository URL and PR-only default-branch protections with Squash/Merge integration, excluding rebase, direct/bypass pushes, and merge-queue batching. These settings must be confirmed before publication is enabled.
- The license choice and corresponding license file.
- npm access to @zeroclover and the selected package names.
- Per-package trusted-publisher setup or an explicitly authorized authenticated first publish where required.

These are activation prerequisites, not permission to guess values or perform a release while implementing the tooling. Report missing inputs and keep publication blocked. All tasks below are implementation work; no live upload, release merge, or release-tag push is implicit.

## 1. Native preparation, scoped identity, and the runbook

- [ ] 1.1 Configure native repository-stored changelogs, retain the private root, and change the pi-tps manifest identity to @zeroclover/pi-tps without changing its directory or runtime identifiers. Include CHANGELOG.md in published files and public access configuration, update lockfile/name references as needed, and fill owner-dependent metadata only from confirmed inputs. Verify manifests, package discovery, scope validation, and absence of unintended version bumps or live release records.
- [ ] 1.2 Create docs/releases.md covering positive/none intents, native all-pending or filtered preparation, matching preview, committed clean inputs, exact versions/prose, first releases, and no stacked preparations. Specify release-focused PRs after source/intents land, allowing multiple branch commits and post-apply prose edits but only one Squash/Merge integration. Verify first/repeat preparation and B-only/shared-intent consumption once in a disposable pinned-pnpm scratch workspace; report commands/results and cleanup without consuming real intents or adding a registry emulator.
- [ ] 1.3 Update AGENTS.md, .agents/skills/pi-extension-dev/SKILL.md, and relevant docs/workflow.md, docs/architecture.md, and docs/conventions.md sections to link that runbook, distinguish scoped identity from directory/commit scope, and remove manual-tag authorization from the procedure. Verify templates and examples agree, generated OpenSpec/harness files remain untouched, and CLAUDE.md remains exactly @AGENTS.md.

## 2. Small repository-specific checks

- [ ] 2.1 Implement the PR release-impact gate for source, runtime manifest/dependency, and declared-resource changes, accepting a decision contributed by this PR or its prepared release records, but not an unchanged old intent. Add focused tests for missing decisions, stale intents, reasoned none decisions, consumed intents, and development-only/preparation-only changes; document these cases in the runbook and include actual tooling in strict checks without weakening configuration. Separate pure parsing/comparison from effectful command orchestration, with small cohesive modules.
- [ ] 2.2 Read the fixed-parent batch, using push-endpoint ledger comparison only to recognize no-ops before the boundary guard. Test A-only, independent A/B, unselected new C, unchanged-version first release, multi-commit PR prose finalization, documentation-only/empty initial pushes, preparation hidden behind a documentation tip, unreadable data, and published-record protection with the withdrawal exception. Document successful no-op versus protocol failure; do not reconstruct batches across pushed history or classify source paths.
- [ ] 2.3 Implement extraction of the unique, non-empty exact-version changelog body and test pnpm's emitted header format, missing/duplicate sections, and byte-preserved manual prose. Keep tooling limited to these repository checks, not a new version solver or publication framework; verify no commit-message or generated-note fallback exists.

## 3. Verify installable artifacts and wire publication

- [ ] 3.1 Add batch-scoped packing and isolated Pi load verification, including installation of declared runtime dependencies outside the workspace. Verify a pi-tps tarball exposes its tps command, includes source/README/changelog, and excludes tests/OpenSpec. Verify the entire batch completes preflight before any upload command, a deliberately incomplete member blocks all uploads, and publication receives the validated artifacts. Document actual inspection/loading commands; do not add deterministic-pack or cross-run integrity-recovery machinery.
- [ ] 3.2 Add PR/default-branch checks with pinned pnpm, frozen-lockfile installation, pnpm check, pnpm change check, and the intent gate. Wire fixed-parent publication with endpoint no-op detection, minimal permissions, OIDC, serialization, availability waiting, and source-SHA tags/releases. Verify ordinary no-op pushes skip publication while quality checks continue and record-changing unsupported pushes fail before batch selection. Document required settings and shared-commit tags; verify no CI versioning, push-range batch reconstruction, source-path classifier, unfiltered publish, or tag-triggered upload.
- [ ] 3.3 Reuse the publisher for automatic runs, original-run retries, and source_sha-only dispatch. Add shared authorization preflight under serialization: fetch the current default head and check only original batch records for continuous presence/immutability through ledger-changing first-parent snapshots. Use structured comparison; optionally parse each distinct ledger blob once per run for the whole batch without dropping intermediate states. Do not substitute literal-key occurrence counts for record semantics. Test formatting-only YAML changes (including key quoting), record-field mutation and restoration with an unchanged key count, withdrawal, identical-key deletion/recreation (old X rejected, new Y eligible), stale/unavailable evidence, unrelated later work, partial A/B success, missing announcements, tag/lookup errors, and expired-run recovery without push-event fields. Document no baseline/package override, no human-only authorization bypass, and no new-source publication; retain small command doubles without a registry emulator or recovery database.

## 4. User-facing guidance and end-to-end review

- [ ] 4.1 Update root and package READMEs plus package templates for individual @zeroclover installs, independent versions, explicit scoped filters, unchanged local directories, and post-publication tags. Verify the extension table and instructions agree with the agent runbook and do not claim an unperformed release is available.
- [ ] 4.2 Rehearse without live writes: B-only preparation with A pending, multi-commit PR landing as one integration, initial/documentation no-op pushes, hidden earlier preparation rejection, safe withdrawal, and same-version re-preparation with old-SHA recovery blocked. Include valid partial-release recovery after unrelated HEAD advancement. Report activation blockers. Verify no names reserved, unapproved license chosen, preparation merged, or packages published, and only authorized fixed-batch members reach publication commands.

## 5. Final integration verification

- [ ] 5.1 Run pnpm check from the repository root, the no-model RPC load smoke test from docs/workflow.md for pi-tps and every other affected package, and the isolated packed-artifact check. Report exact commands and observed results, separating local/dry verification from owner-authorized live publication.

## Workflow follow-up

- After implementation review, archive this repository-wide change through OpenSpec.
- Complete any remaining owner-controlled activation setup before a separately authorized first release; advanced hardening requires a demonstrated need and a separate proposal, not speculative implementation in this change.
