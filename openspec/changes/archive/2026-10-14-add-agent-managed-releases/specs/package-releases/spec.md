# Spec Delta

## Purpose

Publish independently versioned Pi plugins from agent-authored changesets, without delegating release decisions to CI or introducing a second tag-based authorization step.

## ADDED Requirements

### Requirement: Plugin registry names always use the owner scope

Every plugin npm identity SHALL use @zeroclover/<package_name>. The workspace directory SHALL retain the unscoped basename under packages/. Release records, registry operations, and package-name filters SHALL use the full scoped name. The private root MUST NOT be published.

#### Scenario: Publish the existing plugin
- **WHEN** the current pi-tps plugin is configured for publication
- **THEN** its npm identity is @zeroclover/pi-tps and its directory remains packages/pi-tps/
- **AND** its commands, runtime identifiers, and package-scoped specification paths remain unchanged

#### Scenario: Unscoped or private target
- **WHEN** a release batch names an unscoped plugin, a different scope, or a private package
- **THEN** publication rejects that target before upload

### Requirement: Authored changesets determine the release batch

Positive intents SHALL declare release intent and bump types. Local preparation SHALL support all pending packages or a native-filtered subset, with exact versions and final notes reviewed before commit. Unselected packages SHALL retain their pending intent. CI SHALL execute the complete prepared batch without choosing versions, consuming intents, opening release PRs, or adding another package-selection gate. A no-release declaration MUST NOT select a target.

#### Scenario: Two independent versions
- **WHEN** the reviewed preparation records @zeroclover/pi-a at 0.1.2 and @zeroclover/pi-b at 2.1.3
- **THEN** those exact versions are the publication batch without a common repository version or another manual package selection

#### Scenario: Urgent release leaves another package pending
- **WHEN** A has a pending feature intent and the agent prepares only independent B for an urgent fix
- **THEN** only B receives a new prepared release record and enters this publication batch
- **AND** A retains its pending release intent without a forced version or release

#### Scenario: A shared intent is only partly consumed
- **WHEN** one changeset names A and B and native preparation consumes only B's part
- **THEN** pnpm's per-project ledger distinguishes consumed B from pending A even while the file remains
- **AND** the workflow does not manually split the file or infer pending B intent from its presence alone

#### Scenario: Dependency expansion needs an explicit decision
- **WHEN** a local preview includes an additional dependent package
- **THEN** the agent reviews and explicitly declares its release before applying the preparation
- **AND** CI does not silently add that package later

### Requirement: Default-branch publication uses the prepared records

A reviewed preparation PR SHALL land through one Squash or Merge integration commit. CI SHALL publish only its new ledger records relative to its first parent, using that commit for artifacts, notes, and tags. Record-changing pushes SHALL pass the first-parent boundary check before any empty-batch exit. No new records after validation means no publication. Tags, historical records, and registry absence alone MUST NOT authorize upload.

#### Scenario: Unselected new package
- **WHEN** A has a prepared release and new non-private C has no positive intent or prepared record
- **THEN** only A is eligible, even if neither package's current version exists on npm

#### Scenario: First release keeps its initial version
- **WHEN** a preparation adds an initial-release record for 0.1.0 without changing the manifest's existing 0.1.0
- **THEN** CI recognizes it as a release through the prepared record rather than requiring a version-field diff

#### Scenario: Preparation PR contains multiple commits and final prose
- **WHEN** native preparation and later reviewed README/changelog edits land together through one Squash or Merge commit
- **THEN** CI derives the batch from that integration commit and its first parent
- **AND** artifacts, notes, and tags use the integrated final prose without requiring a one-commit PR branch or classifying its intermediate paths

#### Scenario: Unsupported integration or missing parent
- **WHEN** a record-changing push fails the supported-integration, readable-parent, or prior-tip-equals-parent checks
- **THEN** publication stops with a protocol diagnostic before upload
- **AND** it does not guess a baseline, walk the pushed range for earlier preparations, or silently publish a tip-only subset

### Requirement: Proven release no-ops do not fail publication checks

Automatic publication SHALL compare ledger records at both push endpoints before deciding that no release work exists. Identical records SHALL skip publication successfully while quality checks continue. A tip-only empty batch MUST NOT hide an earlier preparation in the same push. Missing history or invalid data MUST NOT be treated as empty state. Endpoint comparison MUST NOT select a publication batch across the push range.

#### Scenario: Documentation-only push
- **WHEN** both push endpoint trees are readable and their parsed ledger records are identical
- **THEN** publication reports no work without failing its boundary guard, even if the update was not a supported release integration
- **AND** normal quality checks and repository protection policy are not waived

#### Scenario: Initial push has no release records
- **WHEN** the initial push has an all-zero before SHA and the after tree has no ledger records
- **THEN** publication skips successfully without requiring a nonexistent parent
- **AND** an initial push containing release records is rejected as an unsupported publication boundary

#### Scenario: Preparation is hidden behind a documentation tip
- **WHEN** one push adds release records in C1 and ends with a documentation-only C2 whose first-parent diff has no new keys
- **THEN** the changed endpoint records cause the invalid integration boundary to be rejected
- **AND** CI neither silently skips C1 nor reconstructs a batch across that unsupported range

#### Scenario: Cannot establish a no-op
- **WHEN** a required nonzero endpoint commit cannot be read or its ledger is malformed
- **THEN** publication fails closed rather than reporting no work
- **AND** a genuinely absent ledger file in a readable tree is distinguished from a failed read

### Requirement: Preparation must not stack unpublished versions

The release procedure SHALL account for registry-dependent planning and retained initial versions. It MUST NOT apply additional intents on top of an already prepared but unshipped version of the same plugin. An unmerged preparation that needs revision SHALL be rebuilt from its pre-preparation state; a merged preparation SHALL be reconciled before the next one.

#### Scenario: Additional changes arrive before first publication
- **WHEN** 0.1.0 is already prepared but unpublished and another change needs inclusion
- **THEN** the agent revises the unmerged batch or completes the existing release before preparing another
- **AND** it does not generate a second 0.1.0 changelog section by stacking preparations

### Requirement: Release descriptions come from reviewed prose

Release prose SHALL originate in manually authored change summaries and the committed package changelog section for the exact version. CI SHALL reuse that section without synthesizing descriptions from commit messages or PR titles. Missing, empty, or duplicate sections SHALL fail preflight rather than trigger generated replacement notes.

#### Scenario: Commit message is unrelated to release prose
- **WHEN** a release commit has a generic commit message and reviewed user-facing changelog text
- **THEN** the GitHub Release body uses the changelog text and no generated commit list

#### Scenario: Duplicate version sections
- **WHEN** a selected package has two changelog sections for its release version
- **THEN** batch preflight stops before any member is uploaded or announced

### Requirement: Tags record package versions after publication

After registry availability is confirmed, CI SHALL create a Git tag named <full-npm-name>@<version> at the release commit and a package-specific GitHub Release. Tags SHALL be output records, not publication triggers or a shared monorepo version. Existing tags MUST NOT be force-moved.

#### Scenario: Two tags identify one source snapshot
- **WHEN** @zeroclover/pi-a@0.1.2 and @zeroclover/pi-b@2.1.3 are published from one preparation commit
- **THEN** CI creates those two distinct tags pointing to that same commit
- **AND** no repository-wide version tag or manually pushed authorization tag is required

### Requirement: PRs declare their own release impact

For plugin source, runtime manifest/dependency, or declared-resource changes, PR validation SHALL require a release or explicit no-release decision contributed by that PR. An unchanged pre-existing intent MUST NOT satisfy this gate. Consumed intents represented by that PR's prepared release records SHALL count; preparation-only bookkeeping and development-only changes MUST NOT require a synthetic positive intent.

#### Scenario: A stale intent cannot hide a new omission
- **WHEN** a PR changes plugin A but contributes no decision for A and the base branch already contains an intent for A
- **THEN** the coverage check fails despite that old intent

#### Scenario: No-release or already-prepared decision
- **WHEN** a PR supplies a reasoned none declaration or corresponding prepared records and notes for its affected plugin
- **THEN** coverage passes without requiring a second positive intent
- **AND** the none declaration never selects the plugin for publication

### Requirement: Validate the actual installable package

Publication SHALL complete quality, notes, and actual tarball/load preflight for the whole batch before any upload attempt. Artifacts SHALL include declared resources, publication metadata, and changelogs, exclude development-only files, and load in Pi outside the workspace with declared runtime dependencies installed. Host-provided Pi packages SHALL remain peer dependencies.

#### Scenario: A workspace-only dependency masks a missing declaration
- **WHEN** a package works in the workspace but its isolated packed installation fails to load
- **THEN** publication fails before uploading any member of the batch

#### Scenario: Valid TypeScript source package
- **WHEN** the selected tarball includes its source entry, resources, changelog, and runtime dependency declarations and passes isolated loading
- **THEN** that validated artifact can be published without a build/dist requirement

### Requirement: Retry the original batch without new version decisions

A retry SHALL use the original prepared batch and commit, skip uploading exact versions already on the registry, and create missing announcements from the committed notes. Only genuine not-found responses SHALL count as absence; other lookup failures SHALL stop execution. Retries MUST NOT bump versions, force-overwrite packages, or silently edit existing release prose.

#### Scenario: Upload succeeded but announcement failed
- **WHEN** a rerun sees the original package version already available and its GitHub Release absent
- **THEN** it skips the upload and creates the missing tag/release from the original commit and notes
- **AND** it considers the original batch, not only packages newly uploaded by this rerun

#### Scenario: Default branch advances before announcement retry
- **WHEN** upload from X succeeded but its announcement failed and the default branch later advances to Y
- **THEN** retry still uses X, its first-parent baseline, and its notes
- **AND** it never creates the missing package tag at Y merely because the ledger still contains that version

#### Scenario: Lookup is unavailable
- **WHEN** a registry or GitHub lookup fails due to authentication, transport, or invalid response data
- **THEN** the workflow fails instead of treating the resource as absent and attempting a replacement

### Requirement: Withdraw a failed preparation only before uploads

The procedure SHALL permit a reviewed forward revert-and-redo only for a preflight-failed batch whose versions have neither been published nor entered any upload attempt. All old publishing attempts SHALL be stopped first. Withdrawal SHALL restore that preparation's pending intents and generated release state without removing published records or rewriting Git history. Partial or uncertain uploads MUST NOT use this procedure.

#### Scenario: Safe withdrawal restores pending work
- **WHEN** execution evidence establishes that the entire failed batch never entered upload and all old publishing attempts are stopped
- **THEN** a reviewed forward revert restores the intents and removes only that failed preparation's records
- **AND** the revert itself publishes nothing; a corrected new preparation is reviewed and merged normally

#### Scenario: One package uploaded or outcome is unknown
- **WHEN** any batch member was published, entered upload with uncertain outcome, or still has a publishing attempt running
- **THEN** withdrawal is forbidden and the operator reconciles the original batch instead
- **AND** registry absence alone is not proof of safe withdrawal

#### Scenario: Published ledger history is changed
- **WHEN** a proposed withdrawal removes a published release record or edits unrelated history
- **THEN** it is rejected rather than treated as the pre-upload withdrawal exception

### Requirement: A withdrawn preparation cannot regain publishing authority

Every publishing entry point SHALL mechanically verify that all original batch records remain present and unchanged through current default-branch integration history. Removal or mutation SHALL invalidate that original preparation even if the same records reappear. The check SHALL use freshly fetched state under publication serialization before uploads or announcements; unavailable evidence MUST stop the whole batch. Validation MUST NOT change the publication source SHA.

#### Scenario: Removed records block all entry points
- **WHEN** preparation X is withdrawn and its batch records removed
- **THEN** delayed automatic publication, original-run retry, and manual recovery for X all fail before uploading or creating announcements

#### Scenario: The same version is prepared again
- **WHEN** X prepares A@0.1.0, R withdraws X, and Y prepares A@0.1.0 again with even identical ledger contents
- **THEN** X remains ineligible because continuity was broken at R
- **AND** Y is evaluated from Y onward and may publish if its authorization and other checks pass

#### Scenario: Unrelated default-branch work advances HEAD
- **WHEN** the branch advances to H while every record of preparation X remains continuously unchanged
- **THEN** X remains eligible and H is recorded as authorization evidence only
- **AND** artifacts, notes, and tags still use X; unrelated new records never expand its batch

#### Scenario: Cannot verify authorization continuity
- **WHEN** fresh default-branch state or required ledger history cannot be fetched or parsed, or any original member fails continuity
- **THEN** every entry point stops the entire batch without using stale state, a human-only override, or a reduced package list

### Requirement: Recover using only the original release SHA

Recovery SHALL accept only the original release integration SHA, derive its first parent, validate its reviewed preparation on the default branch, and reuse the normal batch reader, checks, authority, and serialization. It MUST NOT accept a baseline or package-list override, change versions, bypass validation, or publish newer source. Original-run retries SHALL remain the preferred recovery path.

#### Scenario: Partial publication outlives the rerun window
- **WHEN** A was published from X, B remains missing, and the original workflow can no longer be rerun
- **THEN** recovery for X derives the same A/B batch from X's first parent, skips available A, and publishes missing B after preflight
- **AND** it completes missing announcements from X rather than assuming a GitHub Release command can upload B to npm

#### Scenario: Dispatch runs on a newer workflow revision
- **WHEN** recovery is dispatched from the trusted default-branch workflow for an older authorized preparation
- **THEN** artifacts, notes, and tags use the validated input source SHA rather than the dispatch event's current SHA

#### Scenario: Invalid recovery target
- **WHEN** the SHA is not a reviewed supported preparation integration on the default branch, has no valid parent or prepared batch, or fails normal release checks
- **THEN** recovery rejects it before publication rather than selecting an alternative range or source snapshot

### Requirement: Gate publication on availability and credentials

Only the publication job SHALL receive publishing authority. Publication SHALL be serialized without cancelling an active upload, use bounded availability checks, and announce success only after the exact registry version and tarball are available. Missing owner setup SHALL block upload. These controls MUST NOT require a custom remote-artifact recovery database.

#### Scenario: Upload accepted but not yet installable
- **WHEN** the native availability wait times out after registry acceptance
- **THEN** the workflow reports an incomplete release and preserves the version for retry without re-uploading immediately

#### Scenario: Scope access has not been configured
- **WHEN** @zeroclover is the declared namespace but registry credentials or trusted publishing are unavailable
- **THEN** the workflow reports the required owner setup rather than publishing under another name or assuming the scope decision granted access
