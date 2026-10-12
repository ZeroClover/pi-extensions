# AGENTS.md

This repository is a pnpm monorepo of extensions for [Pi](https://pi.dev), the coding agent. The root holds shared tooling and documentation only. Every extension is a self-contained Pi package in `packages/<name>/`. All implementation is done by AI agents; this file and `docs/` are the contract they work from.

## Before you start

- Read the document that matches your task from the index below, completely, before editing.
- Load the `pi-extension-dev` skill (`.agents/skills/pi-extension-dev/SKILL.md`) whenever you create, change, or debug an extension.
- Pi's API changes quickly. Answer every API question from the docs, examples, and type declarations of the installed Pi version under `node_modules/@earendil-works/pi-coding-agent/` (see `docs/pi-reference.md`), not from memory.

## Rules

1. The root contains no runtime code. Root config files are shared tooling; change them only for repo-wide concerns and never to work around one package's problem.
2. One directory, one package. `packages/<name>/` must work on its own: `pi -e ./packages/<name>` loads it, and its `package.json` declares its own `pi` manifest and dependencies.
3. Host-provided packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`, `typebox`) go in `peerDependencies` with range `"*"`, never in `dependencies`. Pi supplies them at runtime; a bundled copy breaks its module mapping.
4. TypeScript is strict (`tsconfig.base.json`) and Biome enforces lint and format. Fix the code, not the rule: no `any`, no `@ts-ignore` or `@ts-expect-error`, no `biome-ignore` without a reason, no loosening of shared config.
5. Work is done only when verified: `pnpm check` passes and the extension loads (`docs/workflow.md`, "Verify"). Report what you ran, not what you assume.
6. Use pnpm exclusively. Never npm, npx, yarn, or bun.
7. Commits follow Conventional Commits with the package name as scope (`feat(pi-foo): add /foo command`); repo-wide changes use scope `repo`.
8. Keep each package's `README.md` and the extension table in the root `README.md` in sync with the code.

## Commands

Run from the repository root.

| Command | Purpose |
|---|---|
| `pnpm install` | Install tooling and host packages (needed for types, docs, and examples) |
| `pnpm check` | Lint, typecheck, and test; the gate before every commit |
| `pnpm lint:fix` | Apply Biome fixes and formatting |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Individual steps of `check` |
| `pnpm --filter <name> <script>` | Run a package's own script |

## Index

| When you | Read |
|---|---|
| need the repository layout or the anatomy of a package | `docs/architecture.md` |
| write or review TypeScript, choose dependencies, design tools, events, or UI | `docs/conventions.md` |
| create, change, verify, or ship an extension | `docs/workflow.md` |
| look up Pi's API, examples, docs, or type declarations | `docs/pi-reference.md` |
