# Tasks

## 1. Tooling

- [x] 1.1 Export the release tooling's `loadCommands` helper and add `tools/release/test/load.test.ts`, which loads every `packages/*` directory in the root Pi host, offline with an empty agent directory and a working directory outside the workspace; verify `pnpm test` runs it and a broken entry point fails it
- [x] 1.2 Let `ReleaseRepository.readBatch` take an explicit parent, share the pack-then-install-and-load routine between `verifyRelease` and a new `preflightRelease`, and add `cli.ts preflight --base <rev> --head <rev> --work-dir <dir>`; a pull request without new release records is a no-op. Add tests for the preflight's success, no-op, and failure paths
- [x] 1.3 Add the preflight step to `.github/workflows/ci.yml` on pull requests

## 2. Documentation

- [x] 2.1 Update `docs/workflow.md` "Verify" (load test inside `pnpm check`, no local gate requirement, scope excludes release preparations) and the package OpenSpec config template
- [x] 2.2 Update `docs/releases.md` (preflight on preparation pull requests, §4 CI description, Tooling), `AGENTS.md` rule 5 and the commands table, the `pi-extension-dev` skill, `openspec/config.yaml`, and each `packages/*/openspec/config.yaml`

## 3. Verification

- [x] 3.1 Run `pnpm check` and `pnpm change check`; run `cli.ts preflight` locally against a disposable preparation commit and against a branch without records; run the release-impact gate on the branch; verify `openspec validate streamline-verification --strict`
