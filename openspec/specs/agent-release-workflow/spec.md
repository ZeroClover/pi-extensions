# agent-release-workflow Specification

## Purpose

Provide one shared agent release procedure for scoped plugin identities, authored changesets, local version preparation, reviewed publication, and accurate release reporting.

## Requirements

### Requirement: Agents discover one canonical release runbook

AGENTS.md and the extension-development skill SHALL link the same release runbook, and development documentation and templates SHALL agree with it. The runbook SHALL distinguish local preparation from CI execution. It MUST NOT require harness-specific configuration or change the CLAUDE.md redirect contract.

#### Scenario: An agent starts a package change
- **WHEN** an agent reads the repository rules and required extension-development skill
- **THEN** it discovers the same procedure for deciding release impact, authoring changesets, preparing versions, and reporting outcomes

### Requirement: Scoped identity is distinct from local package paths

Agent instructions and package templates SHALL require @zeroclover/<package_name> as the plugin npm name and packages/<package_name>/ as its directory. They SHALL use full names for changesets, registry operations, and name filters, while preserving unscoped local paths and runtime identifiers. Naming the scope MUST NOT be presented as proof of registry access.

#### Scenario: Creating another plugin
- **WHEN** an agent creates the pi-example plugin
- **THEN** the template gives it npm name @zeroclover/pi-example and directory packages/pi-example/
- **AND** package instructions no longer require the directory to equal the full scoped registry name

### Requirement: Changesets express whether a plugin should ship

The runbook SHALL require per-package release summaries and bump choices authored from user-facing changes, not commit messages. A positive intent SHALL mean eventual release, not mandatory inclusion in the next preparation. Deferral SHALL leave it pending rather than mislabel it none. Packages not intended to ship SHALL have no positive intent and any required no-release reason. CI SHALL validate decisions without choosing versions or composing prose.

#### Scenario: No release is desired
- **WHEN** an agent makes a development-only change or explicitly concludes that a plugin need not ship
- **THEN** it creates no positive release intent for that plugin
- **AND** it does not prepare a version merely to defer publication behind a manual tag later

#### Scenario: Two packages change independently
- **WHEN** a change affects two plugins with different release impacts
- **THEN** the agent records their decisions separately instead of applying one commit scope or version to both

### Requirement: Agents prepare and review a selected batch locally

The runbook SHALL support native preparation of all pending packages or a filtered subset, with matching preview, exact-version/scope review, local apply, and final-notes review. It SHALL require committed inputs and a clean working tree before apply, explain per-project consumption and registry-dependent first releases, and prohibit stacked unshipped preparations. CI MUST NOT author these decisions.

#### Scenario: Prepare one package without releasing another
- **WHEN** the agent needs to ship B while independent A's positive intent remains pending
- **THEN** it previews and applies a native filter for B, reviews any dependency expansion, and leaves A pending
- **AND** after merge CI executes all of the resulting prepared batch without another package-selection or tag approval

#### Scenario: Dirty working tree before apply
- **WHEN** intents or intended source changes are not yet committed
- **THEN** the agent can preview with --dry-run but commits them and obtains a clean tree before applying
- **AND** the runbook does not prescribe bypassing this check as the normal workflow

#### Scenario: First release does not increment the manifest
- **WHEN** an unpublished plugin already has its intended initial version in package.json
- **THEN** the agent verifies that version and its new release record rather than forcing another increment

#### Scenario: Preparation needs revision
- **WHEN** another change must join an unmerged, unpublished preparation
- **THEN** the agent rebuilds that batch from the pre-preparation state instead of applying another intent on top of the same unshipped version

### Requirement: Preparation uses a constrained PR integration protocol

The runbook SHALL require source changes and intents to land before a release-focused preparation PR. The default branch SHALL use protected PR-only Squash or Merge integration, without rebase, direct/bypass pushes, or batched merges. PR branches MAY contain multiple preparation/prose commits; their final reviewed snapshot SHALL land in one integration commit. Owner confirmation of these settings SHALL be required before activation.

#### Scenario: Final prose is edited after native apply
- **WHEN** the agent reviews pnpm's generated changelog and adds a prose-fix commit to the preparation PR
- **THEN** it reviews the final result and merges by Squash or Merge without requiring all branch work to be one commit
- **AND** the integration commit and its first parent determine the released snapshot and batch

#### Scenario: Required integration settings are not confirmed
- **WHEN** PR-only protection or supported merge settings have not been confirmed, or rebase/direct/batched integration remains in use
- **THEN** the agent reports the activation blocker instead of assuming first-parent publication is safe

### Requirement: A reviewed merge is the publication boundary

The runbook SHALL state that merging the reviewed release preparation authorizes its complete batch and that CI creates package tags afterward as records. Agents MUST NOT infer permission to merge or bootstrap-publish from a request only to implement tooling or prepare files. The workflow MUST NOT require another manually selected tag for each package after an authorized merge.

#### Scenario: Asked to implement this change
- **WHEN** an agent completes release tooling and documentation
- **THEN** it reports validation results without merging a real preparation, pushing release tags, or uploading packages unless separately authorized

#### Scenario: Two package versions share a release commit
- **WHEN** a reviewed merge contains two independently versioned plugins
- **THEN** the runbook explains that their two version tags can reference the same source commit and do not imply one repository version

### Requirement: Agents report evidence and use the simple retry procedure

The runbook SHALL cover release no-ops, batch preflight, original-source recovery, safe withdrawal, and shared mechanical authorization checks. Reports SHALL distinguish original source SHA and derived parent from the freshly fetched authorization head, plus versions, outcomes, and blockers. Agents MUST NOT resume withdrawn preparations, substitute a human checklist for continuity checks, change retry versions, or claim unimplemented byte-identity verification.

#### Scenario: One upload succeeds and another fails
- **WHEN** a release batch completes only partially
- **THEN** the agent reports each package's state and reruns the original release workflow without changing its batch or versions

#### Scenario: Preflight failure before any upload
- **WHEN** the entire batch fails preflight and the agent proposes withdrawing it
- **THEN** it first stops all old publishing attempts and verifies that no member was published or entered upload, including any bootstrap attempt
- **AND** a reviewed forward revert restores the failed preparation's pending state before a corrected preparation is made
- **AND** it records the withdrawal and never reruns or dispatches the withdrawn SHA; running, partial, or uncertain uploads instead require reconciliation

#### Scenario: Original workflow can no longer be rerun
- **WHEN** the original run exceeds GitHub's rerun window or attempt limit while the release remains incomplete
- **THEN** the agent invokes shared recovery with only the original integration SHA and the workflow mechanically verifies authorization continuity against freshly fetched default-branch state
- **AND** the workflow derives the first parent and processes the original batch, including missing npm uploads, instead of relying solely on a manual GitHub Release command

#### Scenario: A withdrawn version key is recreated
- **WHEN** a corrected preparation Y reuses a package/version key from withdrawn preparation X
- **THEN** the agent uses Y and explains that current key presence does not reauthorize X
- **AND** original-run retries and dispatch of X remain mechanically blocked even if the current ledger record is identical

#### Scenario: No release work versus an unknown batch
- **WHEN** endpoint ledger records are confirmed unchanged or an initial push has no release records
- **THEN** the agent reports publication as a successful no-op while quality checks still run
- **AND** it does not generalize a tip-only empty diff or unavailable history into that conclusion

#### Scenario: Local checks pass but activation is incomplete
- **WHEN** artifact checks succeed but registry ownership verification or credentials remain unavailable
- **THEN** the agent reports the required owner action and does not describe local tests as a successful live publish
