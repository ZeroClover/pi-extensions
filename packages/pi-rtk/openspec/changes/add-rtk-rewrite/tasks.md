# Tasks

## 1. Package setup

- [x] 1.1 Create `packages/pi-rtk/` with `package.json` (`@zeroclover/pi-rtk`, `pi.extensions: ["./src/index.ts"]`, `@earendil-works/pi-coding-agent` as a `*` peer) and its OpenSpec root; verify `pnpm install` lists the workspace project

## 2. Rewrite core

- [x] 2.1 Implement the exit-code mapping in `src/outcome.ts`; verify `test/outcome.test.ts` covers exits 0–3, identical and empty output, multi-line output, other codes, timeouts, signals, and start errors
- [x] 2.2 Implement the process runner in `src/run.ts` on `execFile` (no shell, timeout with `SIGKILL`, abort signal, output cap); verify `test/run.test.ts` against real child processes for exit codes, argument passing, cwd, missing binary, timeout, signal exit, and cancellation
- [x] 2.3 Add `test/rtk-contract.test.ts` that checks the contract against the installed `rtk` and skips when rtk is absent; verify it runs locally

## 3. Tool adapters and configuration

- [x] 3.1 Implement built-in adapters and skip rules in `src/adapters.ts`; verify `test/adapters.test.ts` for command, PTY, shell, `shell: false`, already-rtk, and workdir cases
- [x] 3.2 Implement `<agent-dir>/pi-rtk.json` parsing in `src/config.ts`; verify `test/config.test.ts` for add, replace, remove, invalid entries, invalid JSON, a missing file, and an unreadable path

## 4. Controller, command, and wiring

- [x] 4.1 Implement availability checks, rechecks, suspension, counts, and the rewrite flow in `src/controller.ts`; verify `test/controller.test.ts` with a fake rtk for rewrite, block, skip, missing cwd, off, `RTK_DISABLED`, cancellation, suspension, streak reset, recheck, and the version gate
- [x] 4.2 Implement `/rtk` parsing and the status report in `src/command.ts`; verify the status text in `test/controller.test.ts`
- [x] 4.3 Wire `session_start`, `tool_call` (never throwing), and `/rtk` in `src/index.ts`; verify `pnpm check` passes and the RPC smoke test lists `rtk`

## 5. Documentation and release decision

- [x] 5.1 Write `packages/pi-rtk/README.md` (purpose, install, migration from the `rtk init` hook, provides, configuration with exec-plugin examples, behaviour) and add the row to the root `README.md`; verify every command, setting, and status string matches the code
- [x] 5.2 Record the release decision with `pnpm change --bump minor ... @zeroclover/pi-rtk`; verify `pnpm change status` lists it

## 6. Integration

- [x] 6.1 Live check with a real model in RPC mode: a direct `bash` call is rewritten (`/rtk` reports 1 rewritten)
- [x] 6.2 Live check with pi-unified-exec and codemode `only` mode: a nested `exec_command` call is rewritten and a `tty: true` call is skipped (`/rtk` reports 1 rewritten, 1 skipped)

## Workflow follow-up

- Independent review by the requested agents; resolve every objection.
- Archive the change, then commit as `feat(pi-rtk): ...`.
