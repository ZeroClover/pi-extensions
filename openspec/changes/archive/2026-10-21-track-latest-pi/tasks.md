# Tasks

## 1. Host upgrade

- [x] 1.1 Confirm the target with `pnpm view @earendil-works/pi-coding-agent version` and its versions of `pi-ai`, `pi-tui`, `pi-agent-core`, and `typebox` with `pnpm view @earendil-works/pi-coding-agent@<version> dependencies` (expected at planning time: 1.3.0, and `typebox` 1.3.27); if `latest` has moved, use the new version and read its changelog too
- [x] 1.2 Set the five root `devDependencies` to those exact versions (no caret), run `pnpm install`, and verify that `pnpm-lock.yaml` resolves no `@earendil-works/*` package to 1.1.0, that `node_modules/@earendil-works/pi-coding-agent/package.json` and `pnpm exec pi --version` report the target, and that `node_modules/typebox` is Pi's version
- [x] 1.3 Review the Pi changelogs between 1.1.0 and the target (`node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`) against the APIs each package uses; verify by adding to design.md's "Facts checked while planning" each breaking change and why it does or does not affect `pi-retry`, `pi-rtk`, and `pi-tps` (planning found only the `before_agent_start` change, harmless for pi-retry), and by repeating the list in the final report

## 2. Package documentation

- [x] 2.1 Re-verify the pi-tps "Thinking by backend" table against the target's provider adapters (`node_modules/@earendil-works/pi-ai/dist/providers/`): start-of-thinking source, hidden reasoning, and `usage.reasoning` per backend; correct any row that changed and relabel "(Pi 1.1)" to the target's minor version. Verify with a search for `Pi [0-9]` in `packages/*/README.md` and `packages/*/openspec/specs/` that no statement names an older release
- [x] 2.2 Record `pnpm change --bump none --summary "README: re-verify the thinking table against Pi <version>; nothing to ship." @zeroclover/pi-tps` (a positive bump instead if 2.1 changed a row's facts in a way users should get with the next release); verify `pnpm change status` lists it

## 3. Rules and documentation

- [x] 3.1 Rewrite `docs/workflow.md`, "Upgrade Pi", as "Track the latest Pi": the target definition, the check at the start of extension work, the upgrade procedure with `pnpm view` and exact versions, its own `chore(repo)` pull request carrying the package fixes it needs, done by the agent without an OpenSpec proposal (add it to the work that skips planning in "Plan with OpenSpec"; a package fix that changes user-visible behavior is still proposed in its package root), re-verification of version-labelled statements, and no compatibility code for older releases. Change the verification commands in "Verify" from `pi` to `pnpm exec pi`; verify by re-reading the section against each requirement of the `pi-host-version` spec
- [x] 3.2 Update `AGENTS.md` "Before you start" (the target is Pi's latest stable release; check and upgrade before extension work, without a proposal), `docs/pi-reference.md` (the `node_modules` copy is the target, the latest stable release), the `pi-extension-dev` skill (registry check as the first step), and the "targeted Pi host" wording in `docs/releases.md`; keep `CLAUDE.md` unchanged; verify each edited file against the `pi-host-version` requirements and with the search in 3.3
- [x] 3.3 Add to the root `README.md` that extensions are developed against the latest stable Pi and that updating Pi is the first step when one misbehaves; verify with a search for `1.1.0`, `installed .pi`, and `targeted` outside `openspec/changes/archive/`, `pnpm-lock.yaml`, and `node_modules` that no fixed baseline remains

## 4. Verification

- [x] 4.1 Run `pnpm check` (lint, typecheck, end-to-end scenarios, and the load of every package in the target host) and `pnpm exec pi -ne -e ./packages/<name> --mode rpc` with `get_commands` for each package; verify `openspec validate track-latest-pi --strict` from the repository root
