---
name: pi-extension-dev
description: Build, change, or debug a Pi coding-agent extension in this monorepo. Use when creating or editing anything under packages/<name>/, when registering tools, commands, events, providers, or UI with Pi's ExtensionAPI, or when unsure how a Pi API behaves.
---

# Pi extension development

This repository's rules are in `AGENTS.md` and `docs/` at the repository root. This skill is the procedure that ties them together; it does not repeat them.

## Procedure

1. Read `docs/conventions.md` and `docs/workflow.md` if not already read in this session.
2. Check the Pi target: compare `pnpm view @earendil-works/pi-coding-agent version` with the root `package.json`, and if Pi has a newer stable release, upgrade the host first, without a proposal (`docs/workflow.md`, "Track the latest Pi"). Make sure `node_modules/@earendil-works/pi-coding-agent/` exists; run `pnpm install` if not. It contains Pi's docs, examples, and types for that version.
3. For non-trivial work, plan with OpenSpec first using the package directory as the working directory (`docs/workflow.md`, "Plan with OpenSpec"); a new package gets its own root via `openspec init packages/<name> --tools none`.
4. For every Pi API you will touch, read the relevant section of `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (or the doc named in `docs/pi-reference.md`) and open the closest example under `examples/extensions/`. Confirm signatures in `dist/index.d.ts` when the doc is not explicit.
5. Implement with `src/index.ts` as thin wiring and logic in separate modules. Test the behavior end to end: scenarios in `packages/<name>/test/` that start a real Pi session through `tools/e2e/src/` (`startPi`), name the failure they prevent and the spec requirement they cover, and never import `src/` or fake `pi`/`ctx` (`docs/conventions.md`, "Tests"). A bug fix adds a scenario that fails before the fix.
6. Verify as described in `docs/workflow.md` "Verify": `pnpm check` (which loads every extension in Pi) and a live check for anything that needs a session. Restart Pi after editing `src/`; a running session keeps the old code.
7. Record the release decision for every plugin whose published content changed, following `docs/releases.md`: `pnpm change --bump <patch|minor|major> --summary "<user-facing change>" @zeroclover/<name>`, or `--bump none` with the reason no release is needed. Use the full `@zeroclover/<name>` here; the directory stays `packages/<name>/`.
8. Update the package README and the root README table, archive the OpenSpec change, then commit with the package directory name as scope.

Do not prepare versions, merge a release preparation, or publish unless that is the explicit request; `docs/releases.md` is the procedure when it is.

## When something does not typecheck

The strict settings are intentional. Do not cast, assert, or ignore. Find the type in `dist/index.d.ts`, find an example that uses the same API, and match its shape. If Pi's types genuinely prevent the design, change the design and say so in the final report.

## Report

End with: what changed, what was verified and how (commands and the observed result), and anything not verified.
