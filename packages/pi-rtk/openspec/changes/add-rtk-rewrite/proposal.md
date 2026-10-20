# Proposal

## Why

RTK (`rtk rewrite`) turns shell commands into token-efficient equivalents (`git status` → `rtk git status`), but the single-file Pi hook that `rtk init --agent pi` installs only sees Pi's built-in `bash` tool. Sessions that run commands through pi-unified-exec's `exec_command` get no rewriting, and in `codemode.mode: "only"` with unified-exec active, `bash` is not even present. That hook also probes rtk with a blocking process in the extension factory, ignores RTK's deny exit code, cannot tell a missing rtk from "no rewrite", and keeps paying a timeout per command when rtk misbehaves.

## What Changes

- New package `@zeroclover/pi-rtk` (`packages/pi-rtk/`), a replacement for `~/.pi/agent/extensions/rtk.ts`.
- Rewrites commands in `tool_call` for every tool with an adapter (input field names plus skip rules), covering direct calls and calls made from codemode scripts. Built-in adapters: Pi's `bash` (`command`) and `exec_command` (`cmd`, `shell`, `tty`, `workdir`) as defined by pi-unified-exec and compatible exec plugins.
- Further exec tools are added, replaced, or removed in `<agent-dir>/pi-rtk.json` without code changes: the generic mechanism for third-party exec plugins.
- Follows the full `rtk rewrite` exit-code contract: 0/3 rewrite, 1 unchanged, 2 blocks the call when RTK gives a reason; never executes a deny message.
- Never rewrites PTY sessions, non-POSIX shells, or calls with a missing working directory; every failure leaves the command unchanged (fail open), and the handler never throws.
- Checks rtk at session start (not in the factory), rechecks an unavailable rtk lazily, and suspends rewriting for the session after repeated rtk failures.
- `/rtk` shows the state, adapters, and session counts; `/rtk on|off` toggles rewriting for the session; `RTK_DISABLED=1` turns it off.

## Capabilities

### New Capabilities

- `command-rewriting`: how a shell command in a tool call is sent through `rtk rewrite` and how each result changes, keeps, or blocks the call.
- `tool-adapters`: which tools are rewritten, how their command, shell, PTY, and working-directory inputs are found, and how users configure them.
- `rtk-availability`: detecting a usable rtk, rechecking it, and suspending rewriting when rtk keeps failing.
- `rewrite-controls`: the `/rtk` command, the `RTK_DISABLED` switch, and the footer status.

### Modified Capabilities

None.

## Impact

- New workspace package; no other package changes. Root `README.md` gains a row.
- Runtime dependency: the `rtk` binary (0.25.0 or newer) on `PATH`; without it the extension leaves commands unchanged.
- Users of the `rtk init --agent pi` hook should remove `~/.pi/agent/extensions/rtk.ts`; running both is harmless (commands already starting with `rtk` are skipped) but redundant.
- Out of scope: the user's own `!` / `!!` commands (`user_bash`), output compaction beyond what rtk does, and stdin-continuation tools such as `write_stdin`.
