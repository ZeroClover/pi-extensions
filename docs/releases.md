# Releases

How plugins in this repository are versioned and published. Agents decide what ships by writing change intents and preparing versions locally; CI only executes a reviewed, committed result. This is the single procedure; `AGENTS.md` and the `pi-extension-dev` skill link here.

| Who | Does |
|---|---|
| Agent, in feature work | Records a release decision for every plugin whose published content changed |
| Agent, at release time | Prepares versions and changelogs locally, reviews them, opens a release-focused pull request |
| Reviewer with release authority | Merges the preparation; that merge authorizes publication of its complete batch |
| CI | Validates, publishes the batch from that merge commit, then writes tags and GitHub Releases as records |

CI never chooses versions, consumes intents, writes prose, opens release pull requests, or selects packages.

## Identity

Every plugin publishes as `@zeroclover/<package_name>` from `packages/<package_name>/`: `@zeroclover/pi-tps` lives in `packages/pi-tps/`.

| Use | Form |
|---|---|
| Directory, `pi -e ./packages/<package_name>`, package OpenSpec root | `packages/pi-tps/` |
| `package.json` `name`, change intents, ledger keys, registry, `pnpm --filter` | `@zeroclover/pi-tps` |
| Conventional Commit scope | `pi-tps` (no versioning role) |
| Tags and GitHub Releases | `@zeroclover/pi-tps@0.1.0` |

Runtime identifiers (commands, settings files, session entry types, event channels) never change with the npm name. The private workspace root (`pi-extensions`) is excluded from versioning (`versioning.ignore`) and never published. Naming the scope does not prove that the registry or trusted publishing is configured (see Activation).

Plugin manifests must also list `CHANGELOG.md` in `files`, set `publishConfig.access` to `public`, and declare `pi` resources as plain paths inside `files`. `files` and `pi` entries are plain paths, never globs or `!` exclusions, so every declared resource can be verified in the packed artifact. The release-impact gate checks all of this on every pull request.

## Versioning setup

pnpm (pinned in `package.json` as `packageManager`) provides everything natively; there is no other version tool:

- `.changeset/<id>.md`: change intents, written by `pnpm change`.
- `pnpm version -r`: consumes pending intents, bumps manifests, prepends a section to each package's committed `CHANGELOG.md` (`versioning.changelog.storage: repository` in `pnpm-workspace.yaml`), and records each prepared release in `.changeset/ledger.yaml`.
- `.changeset/ledger.yaml`: append-only records keyed `"<name>@<version>"` with the released `dir` and the consumed intent ids. These records, and nothing else, define what CI publishes.

Versions are independent per plugin. There is no repository version and no `vX.Y.Z` tag.

## 1. Decide release impact in every pull request

A plugin needs a decision when the pull request changes its published content: `package.json`, a README or LICENSE at the package root, or anything under a `files` entry (`src/`, `CHANGELOG.md`, declared skills, prompts, or themes). Tests, the package's `openspec/`, root tooling, and repository docs need none.

Record the decision with pnpm, one plugin or several:

```bash
pnpm change --bump minor --summary "Adds /tps mode to switch the idle summary." @zeroclover/pi-tps
pnpm change --bump none --summary "README wording only; nothing to ship." @zeroclover/pi-tps
```

- A positive intent (`patch`, `minor`, `major`) means the change should eventually ship. It does not force the next release; it stays pending until a preparation consumes it. To defer a release, leave it pending; never relabel it `none`.
- `none` explains why a change needs no release. It never selects a package, and the next `pnpm version -r` deletes none-only intent files.
- Write the summary for users, from the change itself, never from commit messages. It becomes the changelog entry. Summaries are required for every decision.
- Two plugins with different impact get separate decisions; one commit scope or one bump never stands for both.
- Commit the intent with the change.

The CI release-impact gate (`node tools/release/src/cli.ts coverage`) compares the pull request head with its merge base:

| Pull request contains | Gate |
|---|---|
| Published changes and no decision for that plugin | fails, naming the plugin, files, and the command to run |
| Published changes and only an intent already pending on the base branch | fails; old intents never cover new changes |
| A new intent, or an existing one whose bump or summary for that plugin changed | passes |
| A shared intent that this plugin already consumed (it stays on disk for another plugin) | does not count for this plugin |
| A reasoned `none` intent | passes; publishes nothing |
| A `none` or positive intent without a summary | does not count |
| Prepared release records with valid versions and changelog sections (a preparation PR) | passes; consumed intents need not remain |
| Only tests, OpenSpec, root tooling, or docs | passes without a decision |
| A manifest version change without a matching new record, or an edited existing record | fails |
| Removed records that restore the withdrawn pending state (Withdrawal) | passes for the withdrawn plugin, with a notice |
| Removed records that do not restore intents, changelog, or version | fails |
| A plugin named other than `@zeroclover/<directory>`, private, without `CHANGELOG.md` in `files` or public access, or with `pi` resources that are patterns or outside `files` | fails |

The gate verifies that a decision exists; it does not judge the bump type. `pnpm change check` also runs in CI; it validates intent files and versioning invariants, but it is not a coverage check.

## 2. Prepare a release locally

Do this only on an explicit release request. Source changes and their intents must already be merged; the preparation pull request contains only generated release files and reviewed prose.

1. Update the default branch and start a release branch from it. The working tree must be clean: commit everything first. `pnpm version -r` refuses a dirty tree (`ERR_PNPM_UNCLEAN_WORKING_TREE`); `--dry-run` works on a dirty tree, but never use `--no-git-checks` to prepare.
2. Inspect what is pending: `pnpm change status`.
3. Choose the selection and preview exactly it:

   ```bash
   pnpm version -r --dry-run                                  # all pending plugins
   pnpm version -r --dry-run --filter @zeroclover/pi-tps      # a subset (repeat --filter)
   ```

   Both preview and apply contact the npm registry (see First releases); without connectivity, stop rather than guess.
4. Review the plan: every package, its exact version, and its cause. A filter can expand through `workspace:` dependents or fixed groups (`via dependencies` in the plan). pnpm records no ledger entry for a dependency-propagated bump, and CI rejects a version change without a record, so every package in the plan needs its own reviewed intent. If one lacks it, stop: record that intent in a separate pull request, merge it, and start the release branch again from the updated default branch. Every intent a preparation consumes must already be pending on the default branch; CI rejects records whose intents were not. CI never adds packages to a batch.
5. Apply the same selection without `--dry-run`. pnpm creates no commit or tag.
6. Review the result before committing: each manifest version, the new `.changeset/ledger.yaml` records, consumed and remaining intent files, the lockfile if it changed, and every new `CHANGELOG.md` section. Edit the section prose freely; keep its `## <version>` heading and never edit versions or ledger records by hand.
7. Commit (`chore(release): ...`), push, and open a pull request. Further commits on that branch (prose fixes, README updates) are fine; the final reviewed snapshot is what ships.

### First releases

For a planned release pnpm checks whether the package's current manifest version is on the registry. If it is not, the package debuts at that version: `0.1.0` stays `0.1.0`, the pending intents are consumed into the `## 0.1.0` section, and a `"<name>@0.1.0"` record is written. CI recognizes the release by that record, not by a version change. Once a version is published, the next preparation bumps normally.

### Partial preparation

Preparing only B while A has pending intents leaves A's intents untouched. An intent naming both A and B stays on disk after B's preparation because A still needs it; pnpm's ledger records B's consumption per project. Do not split such a file, and do not read its presence as a pending B release: `pnpm change status` is the source of truth.

### Never stack preparations

While a prepared version is unpublished, pnpm still treats it as a first release: applying again adds a second `## <version>` section and merges new intent ids into the existing record. CI rejects both. Therefore:

- To revise an unmerged preparation, rebuild it from the pre-preparation state: land any new or revised intents on the default branch first, reset the release branch to the updated default branch, and prepare again.
- After a preparation is merged, finish its publication (or withdraw it, below) before preparing that package again.
- Retrying a publication never runs `pnpm version`.

### Native behavior verified with pnpm 12.11.2

Verified once in a disposable workspace (not this repository) with `pnpm change` and `pnpm version -r`:

- `--dry-run` on a dirty tree prints the plan; applying on a dirty tree fails with `ERR_PNPM_UNCLEAN_WORKING_TREE`.
- An unpublished package at `0.1.0` with a `patch` or `minor` intent is prepared as `0.1.0`: `## 0.1.0` with `### Minor Changes` / `### Patch Changes` lists, and a ledger record `{ dir, intents }`.
- `--filter` on B consumed B's intent and B's part of a shared A+B intent; the shared file and A's intents stayed pending. A later unfiltered run consumed A and then deleted the shared file. A none-only intent was deleted by the first non-empty preparation.
- Applying a new intent on top of the still-unpublished `0.1.0` produced a second `## 0.1.0` section and added the new id to the existing `0.1.0` record.
- A package whose current version is on the registry was bumped normally (`7.0.0` -> `7.0.1`).
- An intent naming the ignored workspace root fails with `ERR_PNPM_VERSIONING_UNKNOWN_PACKAGE`.

## 3. Merge: the publication boundary

Release preparations land only through pull requests integrated by Squash or Merge (one integration commit per pull request), never rebase merges, direct or bypass pushes, or merge queues; CI rejects a record-changing push that is anything else. The default branch is meant to accept only pull requests (Activation). Merging a reviewed preparation authorizes publication of its complete batch; nothing else does. A request to implement tooling or to prepare a pull request is not permission to merge it, and after an authorized merge no further per-package approval or tag is needed.

Do not merge a preparation while an earlier batch is still incomplete; reconcile it first (Recovery).

## 4. What CI does

`.github/workflows/ci.yml` runs on every pull request and default-branch push: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm change check`, and, on pull requests, the release-impact gate.

`.github/workflows/release.yml` runs on every default-branch push and on recovery dispatch. Tags never trigger it.

1. **Plan** (`cli.ts plan`, read-only). For a push, it first compares the parsed ledger records at the push's `before` and `after` commits. Identical records (formatting does not count) mean a successful release no-op: documentation, source, and intent merges never publish. An initial push skips only if it carries no records. If records changed, the push must be one normal update whose `before` is the first parent of `after`, and `after` must be the squash or merge commit of a pull request merged into the default branch. GitHub also reports the last commit of a rebase merge as a merge commit, so a commit whose first parent comes from the same pull request is rejected. The batch is then the records new in `after` relative to its first parent, each validated: `@zeroclover/<dir>` name, matching `packages/<dir>` record, manifest version, consumed intents that were pending positive intents at the parent and not already consumed by that plugin, and exactly one non-empty `## <version>` changelog section. Every manifest version change needs a record. Edited records, or records added and removed in one commit, are rejected. Removed records are a withdrawal, accepted only when it restores the withdrawn pending state (Withdrawal). Batch members are ordered so that each comes after the batch members whose new version it installs (a `dependencies` or `optionalDependencies` range that accepts that version; `workspace:*`, `^`, and `~` name the current version).
2. **Verify** (`cli.ts verify`, read-only). In a checkout of the release commit: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm change check`, then for every member: `pnpm pack --pack-destination <out> --json`; inspection of the actual tarball (`tar -tzf`, `tar -xzOf <tgz> package/package.json`, the packed changelog section); then, once every member is packed, an install of each outside the workspace as Pi installs packages: a root whose only dependency is `file:<tgz>`, installed with `pnpm install --config.auto-install-peers=false --config.strict-peer-dependencies=false --config.strict-dep-builds=false`, so runtime dependencies are installed and host packages are not. Batch versions are not on the registry yet, so that root's `pnpm-workspace.yaml` overrides each dependency between batch members whose range accepts the batch version, scoped to the edge (`<dependent>@<version>><dependency>`), with the batch tarball. This covers transitive dependencies inside the batch, and every other range, including a dependency on an older version of a member, resolves from the registry as it will for consumers; and a no-model load of the installed copy in the release commit's targeted Pi host (`node_modules/.bin/pi -ne -e <root>/node_modules/@zeroclover/<package_name> --mode rpc` with an empty `PI_CODING_AGENT_DIR` and `PI_OFFLINE=1`, answering `get_commands`). The installed copy must load and expose the same extension commands as the workspace source. The tarball must contain `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, and every committed file of every declared resource (`git ls-files` in the package), and no tests, OpenSpec, or `node_modules`; its manifest must carry the batch name and version, a description, license, repository, and public access, with host packages only as `"*"` peers and no `workspace:` ranges. Only when the whole batch passes are the tarballs and their SHA-256 written to the `release-batch` artifact; one failing member blocks every upload. The load is isolated from the workspace, not from Pi: Pi also resolves extension imports through its own dependencies (for example `yaml`), so an undeclared import of one of those still loads. Declare every runtime import in the package's `dependencies` regardless.
3. **Publish** (`cli.ts publish`, one at a time through the `release-publication` concurrency group, never cancelling a running upload; the only job with `id-token: write` and `contents: write`):
   - Authorization preflight: fetch the current default-branch head H, require the release commit on its first-parent history, re-derive the batch, and require every batch record to stay present and unchanged in every ledger-changing first-parent commit after it. H is recorded as evidence; it is never a release source.
   - Accept exactly the verified tarballs (same keys, same SHA-256).
   - Per member, dependencies first: an exact-version registry hit means skip the upload (its tarball must be served, otherwise stop and rerun later); only a genuine 404 permits `pnpm publish <tgz> --access public --no-git-checks --publish-wait-timeout 600000`. Lookup failures stop the run. The first upload failure stops further uploads.
   - For every available member: tag `<name>@<version>` at the release commit and a GitHub Release whose body is the exact committed changelog section. Existing tags and releases are kept; a tag pointing elsewhere is an error and is never moved.

Two plugins released together get two tags on the same commit (`@zeroclover/pi-a@0.1.2` and `@zeroclover/pi-b@2.1.3`); that does not imply a shared version. Provenance comes from npm trusted publishing.

### No-op or failure

| Situation | Result |
|---|---|
| Ledger records identical at both push endpoints (docs, source, intents, formatting) | success, no publication |
| Initial push without records | success, no publication |
| Merged withdrawal of unpublished records that restores their pending state | success, no publication |
| Record-changing push that is not one Squash/Merge pull request commit on the prior tip (rebase merge, several commits, forced or direct push), including a preparation hidden behind a later commit | failure before any batch is read |
| Unavailable commit, unreadable history, malformed ledger or intent | failure; never treated as empty |
| Invalid batch member, missing/duplicate/empty changelog section, unprepared version change, edited records | failure before upload |
| Removed records whose version is on the registry, or a withdrawal that does not restore intents, changelog, or version, or that also edits other versions | failure |

## 5. Report

After a release, report the original source SHA and its derived first parent, the authorization head H, each package's version and outcome (uploaded, already published, failed, not attempted; tag and release created or existing), and any blocker. Local or dry checks are never reported as a publication.

## 6. Recovery

Never change versions, prepare again, unpublish, or overwrite to retry. Fix published defects with a new forward release.

1. Rerun the original workflow run. It keeps the original commit and batch; every member is revisited, so packages already published are skipped and missing tags and releases are created. GitHub allows reruns for 30 days after the run and 50 attempts.
2. After that, dispatch `Release` from the default branch with only `source_sha`, the original release integration commit. It derives the first parent, runs the same plan, verification, authorization, and publisher, and uses that commit for artifacts, notes, and tags. There is no baseline, package list, or range input, and no way to publish newer source.
3. `gh release create` by hand only repairs a missing announcement for a version already on the registry: `gh release create <tag> --target <original SHA> --title <tag> --notes-file <exact changelog section>`. It uploads nothing to npm, so never use it in place of step 1 or 2 for a missing package.

An accepted upload that is not yet installable (`ERR_PNPM_PUBLISH_AVAILABILITY_TIMEOUT`) is reported as incomplete; rerun later and do not upload again.

## 7. Withdrawal

Only for a batch whose preflight failed before any member entered upload:

1. Stop every queued or running release run that could publish that preparation.
2. From execution evidence (run logs, including any bootstrap attempt), confirm no member was published or entered upload. A registry 404 alone is not evidence. Running, partial, or uncertain uploads require reconciliation (Recovery), never withdrawal.
3. Open a reviewed pull request that reverts the preparation commit: it restores the consumed intents, manifest versions, and changelogs, and removes only that preparation's records. Record the withdrawal and its evidence in the pull request. CI checks that every consumed intent is pending again for its plugin, that the version's changelog section is gone, and that the manifest is back at the version before the preparation: the plugin's highest remaining released version, or the unchanged version of a first release. The gate then accepts the revert as the plugin's decision. Its merge publishes nothing; CI rejects it if a removed version is on the registry.
4. Prepare again normally. The withdrawn commit can never publish again: every entry point checks that its records stayed present and unchanged, so a rerun or dispatch of it fails even after an identical record is prepared again. Never rerun or dispatch it.

## Activation

Publication stays blocked until the owner completes each input. Missing inputs are reported, never guessed.

| Input | Check |
|---|---|
| Repository `ZeroClover/pi-extensions`, license `AGPL-3.0-only` | the manifests |
| Rebase merging disabled; Squash and/or Merge enabled | `gh repo view ZeroClover/pi-extensions --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed` |
| `master`: no force pushes or deletion, required check `Check`, no merge queue, pull requests only | `gh api repos/ZeroClover/pi-extensions/rules/branches/master` |
| npm: publish access to the `@zeroclover` scope, 2FA on the publishing account | owner |
| npm trusted publisher for each package, once the package exists (below) | the package's settings on npmjs.com |

While direct pushes to `master` are still allowed, the tooling keeps enforcing the protocol: a push that changes release records publishes only as the squash or merge commit of a merged pull request, so a preparation never ships from a direct push.

### First release of a package

npm adds a trusted publisher only in an existing package's settings, and no first publish runs through one. The owner therefore creates each new package once by staging a placeholder (bootstrap); every real version, the first included, is then uploaded by CI with provenance. Staging a name that does not exist yet makes npm publish a public `0.0.0-stage` placeholder, while the staged tarball stays private until approved.

1. Outside the repository, logged in as the owner (npm 11.15.0 or later, Node 22.14.0 or later), create an empty directory whose `package.json` holds only `name` (`@zeroclover/<name>`), `version` `0.0.0`, a `description` naming the repository, and `publishConfig.access` `"public"`. Never use the manifest's version: pnpm prepares the first release at that version only while it is absent from the registry (First releases).
2. Stage it from that directory with `npm stage publish --access public`, and do not approve the stage. The package now exists with its `0.0.0-stage` placeholder.
3. Add the trusted publisher (below) right before merging the preparation that first uploads the package.
4. Merge the reviewed preparation as usual. CI uploads the first version through the trusted publisher and creates the tag and GitHub Release.
5. Deprecate the placeholder: `npm deprecate @zeroclover/<name>@0.0.0-stage "Placeholder that reserved the package name; use 0.1.0 or later"`.

Leave the placeholder stage pending; never reject it before the first CI-published version is on the registry, because rejecting the only stage of a new package has been reported to delete the package together with its trusted publisher. Never unpublish a placeholder; deprecate it.

If npmjs.com offers no trusted publisher settings while the placeholder stage is pending, approve it instead (`npm stage list @zeroclover/<name>`, then `npm stage approve <stage-id>` with 2FA). The empty `0.0.0` becomes a real version: continue with step 3 and deprecate `0.0.0` in step 5 as well.

If the publish job fails at the upload because the new package's trusted publisher is missing or expired, create it again and re-run the failed jobs of the same run while it is valid. The re-run skips batch members already on the registry and uploads the rest; that upload is the publish that validates the new configuration.

A bootstrap is owner-approved: agents never perform it, merge a preparation, or dispatch a release without explicit authorization for that action. No manual tag is needed.

### Trusted publisher

Add it in the package's settings on npmjs.com: provider GitHub Actions, owner `ZeroClover`, repository `pi-extensions`, workflow `release.yml`, no environment, and allow direct `npm publish`. Configurations created after 2026-09-03 otherwise allow only `npm stage publish`, and this workflow publishes directly. The CLI equivalent is `npm trust github @zeroclover/<name> --file release.yml --repo ZeroClover/pi-extensions --allow-publish` (npm 11.15.0 or later, interactive 2FA).

A new configuration expires unless a publish through it succeeds within two days; a re-run that only skips existing versions does not count. Add it right before merging the next preparation that uploads the package, and delete and recreate it if it expired. Once it has published, set the package's publishing access to "Require two-factor authentication and disallow tokens".

## Tooling

`tools/release/` holds the repository-specific checks, run with Node's built-in TypeScript support and covered by `pnpm check`: intent coverage (`coverage.ts`), fixed-parent batch reading and validation (`batch.ts`, `repository.ts`), authorization continuity (`authorization.ts`), changelog extraction (`changelog.ts`), and publication orchestration (`commands.ts`, `publish.ts`, `artifact.ts`) behind thin Git, registry, and GitHub adapters. `node tools/release/src/cli.ts help` lists the commands; CI is the normal caller.
