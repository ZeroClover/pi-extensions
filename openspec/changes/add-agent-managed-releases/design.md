# Design

## Context

The private pnpm 12.11.2 workspace publishes independently versioned Pi extension packages. Pi loads TypeScript sources directly, so no build/dist layer is needed. packages/pi-tps/ is the initial packaging and integration target.

Plugin registry identities use @zeroclover/<package_name>, while package directories use the unscoped basename. Repository-wide naming conventions and installation examples must distinguish these identities without changing extension runtime identifiers.

## Goals / Non-Goals

**Goals:**
- Let agent-authored changesets determine what ships, with exact versions and prose reviewed locally.
- Publish the reviewed batch on the default branch, including first releases whose version field does not change.
- Keep repository-specific tooling limited to intent coverage, reading committed release records, and extracting notes.
- Verify the installable Pi artifact and use native publishing behavior wherever practical.

**Non-Goals:**
- Tag-triggered publication, automatic release PRs, CI version preparation, or commit-derived notes.
- Lockstep versions, prereleases, publishing only part of a prepared batch as a normal workflow, or a second versioning engine.
- A remote-artifact integrity recovery system, durable custom publication database, or regression suite for pnpm internals.
- General rebase/batched-push publication support, pushed-history batch reconstruction, or source-path classification. Ledger-only authorization continuity checks are in scope.
- Performing a live release or choosing missing owner-controlled deployment values during implementation.

## Decisions

### 1. Scoped package identity and independent release records

Every plugin manifest uses @zeroclover/<package_name>; the first is @zeroclover/pi-tps. Its directory remains packages/pi-tps/, and its command and runtime identifiers remain unchanged. Changesets, registry operations, dependency references, and name-based pnpm filters use the full scoped name. Directory-based local loading and existing package-specific OpenSpec paths remain valid. The private workspace root is not a plugin and is not renamed or published.

After a package becomes available, CI records its release with a tag named <full-npm-name>@<version> and a matching GitHub Release. For example, these two tags can point to the same commit:

    @zeroclover/pi-a@0.1.2 ----> release commit
    @zeroclover/pi-b@2.1.3 ----> release commit

Git tags name commits, not directory subsets. These names describe the package version released from that snapshot; they do not assert that every package has the same version. npm installation uses the independent package identity. A Git installation still refers to a repository snapshot, not a separately packed plugin. npm itself does not require Git tags; they are retained for source traceability and GitHub Releases, not as publication inputs. There is no repository-wide vX.Y.Z tag.

**Rationale:** scoped names provide explicit publication identity. The reviewed preparation determines the complete batch, so parsing package tags as a second authorization input would duplicate release selection.

### 2. Changesets express intent; local preparation fixes the result

Use the existing pnpm-native commands and set versioning.changelog.storage to repository. Keep the root excluded from version preparation, keep versions independent, and let pnpm maintain .changeset/ledger.yaml. Do not add @changesets/cli, a custom SemVer engine, or a separate release manifest.

An agent writes the full scoped package names, bump types, and user-facing summaries in .changeset/*.md. Positive intents declare eventual release intent; they need not all be consumed in the next preparation. Deferring a package with releasable changes keeps its positive intent pending rather than mislabeling it none. If a plugin should not ship, do not create a positive intent for it. A none declaration is only an explicit explanation of no release and never selects a target.

At release time, prepare either all pending packages with pnpm version -r or a subset with pnpm --filter @zeroclover/<package_name> version -r. Preview the same selection with --dry-run and inspect exact versions before applying. For example, B's urgent fix can ship while A's feature intent remains pending. This local selection determines which intents are prepared; it is not permission to exclude members of an already-prepared batch in CI.

Before applying, commit the intents and other intended source changes and ensure a clean working tree. --dry-run can preview a dirty tree; do not use --no-git-checks as the normal preparation procedure. Recursive preparation does not create its own commit or tags.

Native filtering can expand the plan through workspace dependency or group rules. Review any expansion and add the corresponding release declarations before applying; CI never expands a batch. Independent versioning does not require a dependency-free workspace: each package declares its own runtime dependencies, and any dependency-driven release expansion requires explicit local review and release declarations. Let pnpm track partial consumption per project in its ledger. A shared changeset may remain on disk after B consumes its portion because A is still pending; neither manually split that file nor mistake its presence for a pending B release. Verify this once with pinned pnpm during apply, rather than reimplementing its consumption logic.

Review the resulting manifests, ledger entries, lockfile where needed, and per-package changelog prose before committing. Mechanical assembly from authored summaries is allowed; neither version choice nor prose is inferred from Git messages. Do not manually change manifest versions while leaving pnpm's release records inconsistent. Source changes and their intents land before the release-focused preparation PR. That PR contains generated release files and reviewed prose, not unrelated feature work. Its branch may have multiple commits: final changelog edits can follow native apply, and the reviewed result lands through a single Squash or Merge integration commit. Only that merge authorizes publication of the whole prepared batch.

### 3. Respect registry-dependent preparation and avoid stacked preparations

For planned public releases, pnpm 12.11.2 checks whether the current manifest version exists on the registry. An unpublished current version is retained for the first release; an empty plan does not have the same network requirement. Connectivity and registry responses are prerequisites for preparation, not permission to guess that a version is absent.

If a package's prepared version is still unpublished, adding another intent and applying again can produce another section with the same version. Repeating the command without new pending work is not the same case. The runbook therefore forbids stacking a second preparation for an unshipped package. Rework an unmerged preparation from its pre-preparation state, preserving all intended changes, rather than layering a second apply on top. Once merged, finish publication before preparing that package again, except for the narrowly defined withdrawal below. Retrying an upload never runs the version command.

If the complete batch fails preflight before any upload attempt, the owner may withdraw the preparation through a reviewed forward revert PR, restore its consumed intents and generated version/changelog state, then rework and prepare again. First stop all queued/running attempts that could publish that preparation, verify from execution evidence that no selected version was published or entered upload (including bootstrap), and record the withdrawal in the PR/runbook. Do not infer eligibility merely from a registry not-found response, or cancel an in-flight upload to make it appear eligible. Unknown or partial upload outcomes require reconciliation, not revert-and-redo. The revert removes only this withdrawn preparation's records, preserves all published history, and initiates no publication. Agents must not rerun or dispatch the withdrawn SHA; decision 6 enforces this mechanically for every publishing entry point, even after a corrected preparation recreates the same version key. This is a narrow ledger-edit exception through new Git commits, not a force push, arbitrary ledger editing, or a recovery database.

Keep a unique, non-empty changelog section check as a cheap release preflight. Verify the native first-release behavior once in a disposable scratch experiment during apply and report observed results; do not maintain a mocked registry or an upstream-versioning test suite. If an upstream defect blocks the agreed workflow, report it instead of introducing an undocumented fallback or patching ledger history by hand.

### 4. CI executes one reviewed integration commit

Use the actual configured default branch with PR-only protection and Squash or Merge integration, not rebase, direct/bypass pushes, or merge-queue batching. The owner must confirm these merge/protection settings before publication is enabled. A preparation PR may have multiple branch commits; the restriction is one integration commit on the default branch. Review the final snapshot, including README/changelog edits made after native apply, before merging. Do not combine successive preparations of the same package.

For automatic publication, source_sha is the push event's after commit. First compare the parsed ledger records at the push's before and after snapshots; an absent ledger in a successfully read tree is an empty map, not a fetch failure. If the records are unchanged, report a successful release no-op and skip publication while ordinary quality checks continue. This covers documentation-only pushes, including unsupported integration shapes that carry no net release-record changes; the no-op is not approval of a protection bypass. For an initial push whose before is all zeros, skip publication only if the after snapshot has no release records; otherwise reject the unsupported release boundary. Unavailable commits, malformed ledger data, or unreadable required history are errors, not evidence of no batch.

If ledger records changed, require push.before to equal source_sha's first parent and a normal, non-forced update through the supported PR integration protocol before reading the first-parent batch. A missing parent, boundary mismatch, or unsupported integration stops publication even if the tip-only diff has no new keys: a preparation earlier in the push followed by a documentation commit must not silently disappear. This endpoint comparison only decides whether publication needs evaluation; it never chooses a push-range batch. The equality check alone does not establish PR authorization; branch protections and reviewed preparation membership remain prerequisites.

The batch is the new ledger keys in source_sha^1..source_sha. Validate each scoped package/version against its manifest and unique reviewed changelog section at source_sha. After the endpoint/boundary checks and ledger-history validation, no new keys means no new publication, including for a valid pre-upload withdrawal or never-published packages. Use that same SHA for packing, loading, upload, notes, and tags. Do not reconstruct this batch by walking record-introduction history or classifying source paths. The separate authorization check in decision 6 reads only ledger history for this already-fixed batch. A normal rerun retains its original event SHA; the parent is always derived, never caller-selected.

Only changeset-backed prepared records authorize targets. Historical records are not a queue to scan against npm, and a first release is recognized even when its manifest stays at 0.1.0. Reject arbitrary record modifications and version edits substituted for preparation; the sole withdrawal exception is decision 3, which cannot remove published history. Local native filters choose what to prepare; CI has no second publication filter list.

**Rationale:** scanning every historical ledger key cannot recover a missing tag's original source SHA; supporting every integration shape requires unnecessary history and path analysis. Constraining merges removes that analysis without giving up reviewed final prose or original-source retries. Retain a minimal boundary failure check rather than assume repository settings can never drift.

Use an explicit package set with pnpm publishing. Unfiltered pnpm publish -r can publish a never-published non-private package with no changeset; a private flag is not the only intent safeguard. Use pinned tooling and Actions, frozen-lockfile installation, and minimal permissions. Serialize publication without cancelling an active upload, and reconcile an incomplete batch before merging the next preparation. Only the publication job receives OIDC publishing authority; PR checks and the batch reader do not. Generated version tags never trigger another upload.

### 5. A focused PR intent gate checks this change, not stale declarations

Run pnpm change check as native validation of existing declarations/configuration. In pnpm 12.11.2 it is not a Git-diff coverage gate; do not assume it detects a missing declaration.

Add a small repository-specific coverage check against the PR merge base. For each plugin with relevant source, runtime dependency/manifest, or declared resource changes, require a new or meaningfully updated declaration in this PR for that plugin, including an explicit none reason when no release is warranted. An unchanged pending intent from the base branch cannot satisfy the check. A PR that includes already-prepared release records and notes can satisfy coverage through those records; consumed intents are not required to remain on disk. Pure test, OpenSpec, root-tooling, and development-documentation changes do not demand a positive intent.

The check verifies that an agent made a decision; it does not infer patch/minor/major or validate the semantic quality of the decision. Ordinary preparation-only PRs do not need another changeset for their generated version/changelog edits. Keep this separate from publication eligibility: passing a no-release declaration never makes a package publishable.

### 6. Verify packages and keep recovery small

Complete repository checks, note validation, and packed-artifact/load preflight for the entire batch before attempting any member's upload. Pack only the batch members, include CHANGELOG.md explicitly in files, and inspect the actual file list and manifest. Keep TypeScript source publication, runtime dependencies in the package, and Pi host peer dependencies with the required ranges. Check required publication metadata before attempting a live upload.

Install the selected tarball and its declared dependencies outside the workspace, with isolated Pi settings and a targeted host. Merely extracting a tarball does not install tokenx or other runtime dependencies. Run the no-model RPC smoke test; for pi-tps assert its tps command and absence of load errors. Publish the validated artifact rather than using a different checkout. Passing that artifact between CI jobs is normal workflow plumbing, not a persistent recovery store.

For each batch member, a successful exact-version registry lookup means skip uploading that existing version. Only a genuine not-found response permits a new upload; authentication/network/decoding failures stop the run. Use pnpm's native publish-wait timeout for accepted uploads. For a skipped version, require registry metadata and its tarball to be available before announcing; if not, stop and rerun later rather than invent a polling service. Keep provenance/trusted publishing where supported.

After availability, create the package tag at the original release SHA and the GitHub Release from the exact committed changelog section. Existing releases are left alone; a tag already pointing elsewhere is an error, not something to force-move. Distinguish a missing GitHub release from authentication or transport failures; do not use an unconditional shell fallback that interprets every failure as absence. Do not auto-edit differing release prose or implement remote artifact comparison.

A retry visits every member of the original committed batch, including packages whose upload already succeeded, so it can fill in a missing announcement. Do not derive retries only from the current run's newly-uploaded summary. Partial success is reported per package; successful uploads are not rolled back and versions are not changed to retry.

Prefer rerunning the original GitHub Actions run: it retains the original event SHA even if the branch has advanced. GitHub currently limits reruns to 30 days after the initial run and 50 attempts, independently of log retention. A deterministic preflight failure is not repaired by repeating it; a never-uploaded batch may use decision 3's withdrawal procedure.

Keep workflow_dispatch on the trusted default-branch workflow with just source_sha, the original release integration commit. Resolve the full SHA, verify that it identifies a reviewed Squash/Merge preparation in default-branch integration history, derive its first parent, and invoke the same batch reader and publisher. The shared mechanical authorization check below confirms that the preparation has not been withdrawn; the operator checklist does not replace it. There is no baseline input, arbitrary range selection, package-list override, or alternate validation/publishing algorithm. The same quality/artifact checks, permissions, OIDC authority, and serialization apply. Invalid or unverifiable targets stop before upload; dispatch cannot legalize an unsupported integration or repair invalid source. Artifacts, notes, and tags use the input SHA, never the dispatch event's newer GITHUB_SHA.

All automatic, rerun, and dispatch paths use one authorization preflight after obtaining publication serialization and before any registry upload or tag/release write. Fetch the current default-branch head H, record H in the result, and verify source_sha is on its first-parent integration history. For the batch derived solely from source_sha^1..source_sha, require every record to remain present and structurally unchanged from source_sha through H. Read only ledger-changing first-parent snapshots after source_sha, plus the current ledger; any removal or record mutation invalidates that original preparation, even if the same key and identical contents are subsequently restored. Ignore formatting-only YAML changes, not record changes. Fail closed on fetch, history, or parsing errors; do not substitute a cached event-era head or filter out an invalid member to publish a partial batch.

Implement this as structured record comparison, not a literal key-occurrence search. Git's -S pickaxe detects changes in the number of occurrences of a string: changing YAML key quoting can match without changing the parsed record, while editing a record's dir or intents can leave the key count unchanged. A later restoration does not excuse an intervening mutation, and the policy forbidding mutation does not replace its mechanical detection. To avoid redundant parsing, the implementation may cache parsed ledgers by Git blob ID within the run and compare the whole original batch together. Preserve the first-parent snapshot sequence and inspect every ledger-changing state; deduplicating parsing must not collapse intermediate removals/mutations into an endpoint comparison. This optimization reduces parsing work without persisting recovery state or weakening authorization checks.

For X (prepare A@0.1.0), R (withdraw X), Y (prepare A@0.1.0 again), X is permanently ineligible because its record disappeared at R; Y can pass continuity from Y onward. Current-key existence or endpoint record equality alone cannot distinguish them. Unrelated later records and later versions do not invalidate an unchanged original record. H is validation evidence, never the package, notes, or tag source. This narrow ledger-history check is an explicit cost, not a single current-state comparison or a new registry/recovery database. It does not replace the requirement to stop all publishing attempts before withdrawal; no atomicity across Git and npm is claimed.

This small recovery entry covers expired runs and partial A/B publication as well as missing announcements. It skips existing exact versions and uploads missing members from the original source. A manual gh release create is only an announcement repair after availability and tag-target checks, with an explicit original --target SHA when creating a missing tag and the exact committed notes; it does not upload missing npm packages. Do not make manual announcements the only out-of-window recovery procedure. No extra human package selection is added to normal successful releases.

**Trade-off:** existing-version skipping trusts the controlled namespace and publishing process; immutability and OIDC alone do not prove byte identity or eliminate all other publishers. Package ownership, limited credentials, and pre-upload artifact validation are the proportionate first-layer controls.

### 7. Minimal tooling, tests, and agent documentation

Use a few small TypeScript tooling functions/scripts for the coverage check, batch reading, and note extraction, with focused tests for this repository's behavior. Reuse a maintained structured-data parser if needed; no custom YAML parser, publication framework, registry emulator, or duplicate version algorithm. Include actual repository tooling in strict tsc/Biome/Vitest checks as needed; the ban on root extension runtime code does not ban root development tooling or its tests.

Organize release tooling by responsibility: intent coverage, fixed-parent batch and ledger validation, changelog extraction, and publication orchestration. Keep parsing and comparison functions pure where practical; isolate Git, filesystem, registry, and process effects in a thin orchestration layer. Push-endpoint no-op and boundary checks belong to the push-event entry path. Source-SHA recovery derives the parent from its input and must not require push-event fields. Both paths reuse the batch reader and publisher, with fresh authorization evidence fetched under publication serialization before writes.

Keep focused tests of our command orchestration: exact-version skipping, distinguishing not-found from errors, partial success, announcement retry, and tag conflicts. A small command runner seam or command test doubles are sufficient; do not require generic registry/GitHub adapter interfaces, an emulator, or a publication framework. These tests verify our branching and call order, not npm or GitHub internals. A workflow dry run complements them but cannot exercise error branches by itself.

Add docs/releases.md as the canonical runbook and link it from AGENTS.md and .agents/skills/pi-extension-dev/SKILL.md. Update docs/workflow.md, docs/architecture.md, and docs/conventions.md only where the procedure, naming, or tooling layout changes. Update root/package README installation examples and templates to @zeroclover/<package_name>, while preserving local directory names, package OpenSpec roots, and runtime identifiers. Conventional Commit scope can remain the short directory name, for example feat(pi-tps), with no versioning role.

Document that changesets express release intent and merging the reviewed preparation is the publication boundary. A request to implement tooling or prepare a PR does not authorize merging it or performing a first authenticated bootstrap. Do not request a second per-package tag approval after an authorized release merge. Keep CLAUDE.md exactly @AGENTS.md and leave generated OpenSpec skills and harness-specific files alone.

## Risks / Trade-offs

- **New native versioning semantics and registry dependency** -> Pin pnpm, perform one-time acceptance checks, document first releases, and do not stack unshipped preparations.
- **Simple batch reading depends on merge policy** -> Recognize no-ops by push-endpoint ledger comparison; check the first-parent boundary for record-changing pushes before any tip-only empty-batch exit. Preserve original-source retries with a derived parent.
- **A withdrawn version key can reappear** -> Check ledger-only continuity from the original preparation through a freshly fetched default-branch head for every publishing entry point; deletion/restoration never reauthorizes the old SHA. This adds limited authorization-history reading, not source-path analysis.
- **Scoped naming differs from current templates** -> Update full-name versus directory conventions and filters together; do not retain an unscoped publication fallback.
- **Native checks do not enforce PR coverage** -> Add a small diff-based intent gate with release-preparation and no-release cases, not a semantic-change classifier.
- **Publication is not atomic across packages** -> Preflight the whole batch first, skip existing exact versions, and retry the original batch, including after the rerun window via single-SHA dispatch. Never use revert-and-redo for partial or uncertain uploads.
- **Publication depends on owner-controlled setup** -> Require confirmed metadata, repository protections, and publishing access before activation; fail closed and report missing inputs.

## Migration Plan

1. Rename only the publication identity to @zeroclover/pi-tps, configure native repository changelogs, and update conventions/templates during apply. Keep packages/pi-tps/ and its runtime surface unchanged. Do not prepare or publish a real version as part of setup.
2. Deliver the runbook, focused checks, packing/loading validation, and default-branch publisher as one small end-to-end layer. Keep tooling limited to the batch protocol and bounded recovery defined here.
3. Complete owner-controlled activation inputs listed at the top of tasks.md, including the PR-only Squash/Merge protocol and no batched integration. If npm requires an authenticated first publish before trusted-publisher setup, obtain explicit approval, use the reviewed prepared package/version and artifact, and then rerun the normal workflow after trust is configured. No manual Git tag is required for this bootstrap.
4. On an authorized release request, prepare and review all pending packages or a native-filtered subset locally, merge the preparation, and let CI publish and record its complete batch. Once published, fix defects through a new authored forward release, not by overwriting or unpublishing old versions.

## Open Questions

- Owner-supplied deployment inputs: final GitHub repository URL, chosen license, npm access to @zeroclover, and trusted-publisher/first-publish configuration.

## References

- https://pnpm.io/versioning
- https://pnpm.io/cli/version (native filtering and clean-tree requirement)
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs (original event SHA on rerun)
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch
- https://docs.github.com/en/webhooks/webhook-events-and-payloads#push (before/after boundary guard)
- https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- https://cli.github.com/manual/gh_release_create
- https://pnpm.io/cli/change
- https://pnpm.io/cli/publish
- https://changesets.dev/guide/versioning-and-publishing
- https://changesets.dev/guide/cli#publish (accidental publication of new packages)
- https://yarnpkg.com/cli/version/check and https://rushjs.io/pages/commands/rush_change/ (intent coverage precedent)
- https://docs.npmjs.com/trusted-publishers/
- https://github.com/pnpm/pnpm/blob/v12.11.2/pnpm/crates/versioning/src/changelog.rs
- https://github.com/pnpm/pnpm/blob/v12.11.2/pnpm/crates/cli/src/cli_args/change/report.rs
