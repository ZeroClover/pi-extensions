# Design

## Context

The host version is set in one place, the root `devDependencies` (`^1.1.0` for the four `@earendil-works/*` packages, `^1.3.27` for `typebox`), and resolved by the lockfile to 1.1.0. Everything else follows from it: `node_modules/@earendil-works/pi-coding-agent/` provides the docs, examples, and types agents must read (`docs/pi-reference.md`), `tsc` checks against those types, the end-to-end harness (`tools/e2e/`) and the load test start that host, and release verification loads packed artifacts in the release commit's host. The only rule about moving it is `docs/workflow.md`, "Upgrade Pi": keep the entries at the version of the installed `pi`.

Facts checked while planning:

- The `latest` dist-tag of `@earendil-works/pi-coding-agent` is 1.3.0; the only other tag is `legacy-node20` (0.74.2). `pi-ai`, `pi-tui`, and `pi-agent-core` also tag 1.3.0.
- Pi 1.3.0 pins its internal dependencies exactly (its changelog: "Pinned internal Pi dependencies to exact release versions"): `pi-ai`, `pi-tui`, `pi-agent-core` 1.3.0 and `typebox` 1.3.27, while `typebox`'s own `latest` is 1.4.2.
- The caret had already drifted: before this change the lockfile resolved the root `typebox` (`^1.3.27`) to 1.3.36, past Pi 1.3.0's pin of 1.3.27.
- A trial bump to 1.3.0 (reverted after the trial) passed `pnpm check` with no code changes: lint, `tsc`, 55 tests in 18 files, every package loaded.
- The 1.2.0 and 1.3.0 changelogs contain one breaking change that touches a package here: `before_agent_start` also fires for runs started by `pi.sendMessage(..., { triggerTurn: true })`. pi-retry uses it only to reset its attempt counter for a new run, which is still correct for such a run. The retryable errors Pi added in 1.3.0 (`Unable to forward upstream stream`, `The service is temporarily unavailable`, `The upstream provider returned an error`) are already in pi-retry's vocabulary.
- The only version-labelled statement in package docs or specs is `packages/pi-tps/README.md`, "Thinking by backend" ("(Pi 1.1)").

Changelog review during apply (Pi 1.2.0 and 1.3.0; 1.3.0 has no "Breaking Changes" section), against the APIs the packages use (`pi.on` for session, agent, turn, message, provider, `tool_call`, `context`, `model_select`, and `cache_warming_decision` events; `registerCommand`, `getAllTools`, `getSettings`; `ctx.abort`, `hasPendingMessages`, `ui.notify`, `ui.setStatus`, `ui.onTerminalInput`, `sessionManager.getBranch`):

- Theme schema validation (1.2.0): no package ships a theme. Not affected.
- `before_agent_start` also fires for custom-message runs, and `BeforeAgentStartEvent` became a union on `messageType` (1.2.0): pi-retry ignores the payload and only resets its attempt counter, which is correct for any new run. Not affected.
- The session counts as busy while a run starts (`ctx.isIdle()`, `pi.sendMessage()`, `pi.sendUserMessage()`, aborts during start) (1.2.0): no package calls these; pi-retry's `ctx.abort()` runs at `agent_before_settle`, after the run started. Not affected.
- `pi mcp list --json` output (1.2.0): unused. Not affected.
- Pi's retryable list (`pi-ai` `dist/utils/retry.js`) widened `service.?unavailable` to `service.?(?:is.?)?(?:temporarily.?)?unavailable`, `provider.?returned.?error` to `provider.?returned.?(?:an.?)?error`, and added `unable to forward upstream` (1.3.0). pi-retry's vocabulary already contains all three, so its error-classification scenario "Pi's lists are covered with documented differences" still holds. Not affected.

## Goals / Non-Goals

**Goals:**
- The repository states its current target in exactly one place, and the documented rules never need editing when Pi releases.
- Every extension task runs on the current target, checked by a single registry lookup.
- Every check an agent runs (types, end-to-end scenarios, load, live checks) uses the same host version.

**Non-Goals:**
- Automated upgrade pull requests (Dependabot, Renovate, a scheduled workflow). They can be added later without changing the policy.
- Declaring or testing a minimum Pi version for users; see "No compatibility with older releases".
- Rewriting archived OpenSpec changes that mention 1.1.0.

## Decisions

### "Latest stable" is the `latest` dist-tag of pi-coding-agent

It is what `pi install` and `npm install` give users, and npm already excludes prereleases from it. A semver query ("highest non-prerelease version") was rejected: it can disagree with what Pi's maintainers publish as current, for example after a deprecation, and needs more tooling than `pnpm view @earendil-works/pi-coding-agent version`.

### The other host packages follow Pi's dependencies, not their own tags

Pi pins `pi-ai`, `pi-tui`, `pi-agent-core`, and `typebox` exactly, and resolves them at runtime from its own dependencies. A root copy at a different version would type-check extensions against a package Pi does not run. `pnpm view @earendil-works/pi-coding-agent@<version> dependencies` gives the versions to use.

### Exact versions in the root manifest

The entries change from `^1.1.0` to exact versions (`1.3.0`, `typebox` `1.3.27`). A caret range says "1.x" while the lockfile decides the version, so the manifest cannot answer "what do we target?", and a lockfile refresh could resolve `typebox` past Pi's pin. With exact versions the manifest is the single statement of the target, the check before extension work is a comparison of one string, and the five entries move together by construction.

### The check runs at the start of extension work, not in CI

The `pi-extension-dev` skill and `AGENTS.md` make the registry lookup the first step of creating, changing, or debugging an extension. A CI comparison with the registry was rejected: it needs network access in `pnpm check`, which the end-to-end tests forbid, and it would turn a green pull request red the moment Pi releases, blocking unrelated work until someone upgrades. The cost is that a repository with no extension work can fall behind; nothing is developed against the stale host in the meantime, and the next task catches up.

### The upgrade is its own pull request, carrying every fix it needs

When the target has moved, the agent upgrades first in a `chore(repo): upgrade Pi host to <version>` pull request, then does the extension work on top. The upgrade includes whatever keeps `pnpm check` green and package docs true: package fixes and doc corrections, each with a release decision for its package. The upgrade needs no OpenSpec proposal: its steps are fixed by `docs/workflow.md`, so a proposal would only restate them, and requiring one would bring back the per-release manual step this change removes. `docs/workflow.md`, "Plan with OpenSpec", lists it among the work that skips planning; only a package fix that changes user-visible behavior is proposed in that package's root. Mixing the upgrade into a feature pull request was rejected because a reviewer cannot then tell which changes Pi forced and which the feature made. Upgrading without fixes was rejected because `pnpm check` must pass on every commit to the default branch.

### Live checks run the workspace's Pi

`docs/workflow.md` currently tells agents to keep the host at the installed `pi`, so the global CLI decides the target. The verification commands change from `pi` to `pnpm exec pi`, which runs the workspace host (`node_modules/.bin/pi`, the same binary the load test uses) with the user's normal agent directory and credentials. Live checks then always run the target, whatever the global `pi` is. User-facing install instructions (`pi install`, `pi -e`) stay as they are.

### No compatibility with older releases

Extensions are written against the target's API only. Supporting older releases would need a version matrix in CI and fallback code that no test on the target exercises. Peers stay `"*"`: a minimum version would have to be bumped on every upgrade and would make `pi install` refuse working combinations. The root README tells users that extensions are developed against the latest stable Pi and that updating Pi is the first step when one misbehaves.

### Version-dependent statements carry the version they were checked against

A package statement about Pi's behavior that can change between releases (adapter capabilities, Pi's own retry lists) names the release it was verified against, so an upgrade can find it with a search for `Pi <digit>` in package READMEs and specs. For this change the pi-tps table is checked against the Pi 1.3.0 provider adapters (`pi-ai` 1.3.0 `dist/providers/`) and relabelled "(Pi 1.3)"; any row that changed is corrected.

## Risks / Trade-offs

- [A Pi release breaks an extension in a way the end-to-end scenarios do not cover] → The upgrade reads every skipped changelog and checks the APIs each package uses against its breaking changes; live checks follow for anything the scenarios cannot reach.
- [Users on an older Pi meet an extension that uses a newer API] → Documented in the root README; the failure shows at load time, which the user resolves by updating Pi.
- [`pnpm exec pi` and a global `pi` differ in a live check] → The workspace host is the reference; a difference is reported as such, not treated as an extension bug.
- [An upgrade with many breaking changes delays the extension work that triggered it] → The upgrade is a separate, reviewable pull request; the extension work starts on top of it.

## Migration Plan

One pull request: the root manifest and lockfile move to Pi 1.3.0 with exact versions, the docs and skill state the new rules, and the pi-tps README is relabelled with a `none` release decision. Rollback is a revert; no published package changes.
