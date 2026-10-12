---
name: pi-extension-dev
description: Build, change, or debug a Pi coding-agent extension in this monorepo. Use when creating or editing anything under packages/<name>/, when registering tools, commands, events, providers, or UI with Pi's ExtensionAPI, or when unsure how a Pi API behaves.
---

# Pi extension development

This repository's rules are in `AGENTS.md` and `docs/` at the repository root. This skill is the procedure that ties them together; it does not repeat them.

## Procedure

1. Read `docs/conventions.md` and `docs/workflow.md` if not already read in this session.
2. Make sure `node_modules/@earendil-works/pi-coding-agent/` exists; run `pnpm install` if not. It contains Pi's docs, examples, and types for the targeted version.
3. For every Pi API you will touch, read the relevant section of `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (or the doc named in `docs/pi-reference.md`) and open the closest example under `examples/extensions/`. Confirm signatures in `dist/index.d.ts` when the doc is not explicit.
4. Implement with `src/index.ts` as thin wiring and logic in separate modules with tests.
5. Verify as described in `docs/workflow.md` "Verify": `pnpm check`, the RPC load smoke test, and a live check for anything that needs a session. Restart Pi after editing `src/`; a running session keeps the old code.
6. Update the package README and the root README table, then commit with the package name as scope.

## When something does not typecheck

The strict settings are intentional. Do not cast, assert, or ignore. Find the type in `dist/index.d.ts`, find an example that uses the same API, and match its shape. If Pi's types genuinely prevent the design, change the design and say so in the final report.

## Report

End with: what changed, what was verified and how (commands and the observed result), and anything not verified.
