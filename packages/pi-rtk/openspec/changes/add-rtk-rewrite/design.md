# Design

## Context

See `proposal.md` for motivation. Facts that shape the design:

- Pi's `tool_call` event lets a handler mutate `event.input` before the tool runs or return `{ block, reason }`. It fires for model calls and for nested calls made with `ctx.executeTool()`, which is how codemode scripts call tools. A throwing handler blocks the tool.
- `rtk rewrite <cmd>` is RTK's single source of rewrite rules. Exit codes: 0/3 rewrite printed (3 defers permission to the host), 1 no rewrite, 2 deny (with a message: block it; without: defer to the host's deny rules). It takes about 15 ms and does not itself honour `RTK_DISABLED`.
- `pi.exec()` reports a binary that cannot start as exit code 1 (indistinguishable from "no rewrite") and a signal exit as code 0.
- A survey of exec plugins on npm (pi-unified-exec, @chensl/pi-unified-exec, pi-exec-command, @howaboua/pi-codex-conversion, pi-smart-terminal, pi-bg-bash, pi-landstrip, @ian-pascoe/pi-termctrl, …; pi-smart-terminal and pi-landstrip replace `bash` under its own name) found two shapes: replacements of `bash` that keep the name `bash` and its `command` field, and Codex-style `exec_command` tools with `cmd`, `shell`, `tty`, and `workdir`. Background-task tools use `command`: `bg_run` (pi-background-tasks), `bash_bg` (pi-bg-shell), `bg_task_spawn` (pi-better-background-tasks, which can also run remotely), `bash_async` (@ryan_nookpi/pi-extension-bash-async). PTY-session tools such as pi-smart-terminal's `terminal_exec` cannot be described by an adapter and must not be configured. None of the existing Pi RTK plugins acts on exit code 2. Several treat any stdout as a rewrite, so they would run a deny message as a command.

## Goals / Non-Goals

**Goals:**
- One mechanism that covers Pi's `bash`, pi-unified-exec, codemode, and any exec tool that a user describes in configuration.
- The command the model wrote runs unchanged whenever RTK cannot answer cleanly. The only exception is an explicit RTK deny.
- No work in the extension factory, and no per-command cost while rtk is known to be missing or broken.

**Non-Goals:**
- Rewriting the user's `!`/`!!` commands (`user_bash`). The only way to change them is to return replacement `operations`, and the first handler that returns operations wins. Doing so would take execution away from sandboxing or remote-shell extensions (pi-landstrip, the ssh example, pi-smart-terminal). The user also typed those commands deliberately.
- Rewriting stdin-continuation tools (`write_stdin`, `terminal_send`). Their input is keystrokes, not commands.
- Output compaction, token statistics, or prompt injection. `rtk gain` reports savings, and `rtk init` already provides the model-facing RTK instructions.
- Re-registering `bash` or using `spawnHook`. That conflicts with every plugin that replaces `bash` and does not reach other tools.

## Decisions

### `tool_call` mutation driven by an adapter table
An adapter names the input fields of one tool: command (required), and optionally shell, PTY, and working directory. Built-ins cover `bash` and `exec_command`. `<agent-dir>/pi-rtk.json` adds, replaces, or removes entries. This is the generic answer for third-party exec plugins: a new tool needs one JSON entry, not code.

Alternatives considered:
- **PATH shims or `BASH_ENV` functions.** They work per binary instead of per command, so they lose RTK's chain- and pipe-aware rules. They also compress output that scripts parse, and login shells defeat them (macOS `path_helper`).
- **Auto-detecting any tool with a string `command`/`cmd` field.** This guesses at semantics and could rewrite a tool where "command" means something else, such as a remote or Nushell executor. It stays opt-in through configuration.

Only bash and `exec_command` are built in, because they were verified against the installed tools. Other plugins are documented as configuration examples.

### Skip rules in the adapter
A PTY call is never rewritten, because RTK filters output, which breaks interactive programs (`ssh host` → `rtk ssh host`). A non-POSIX `shell` or `shell: false` is never rewritten, because RTK's rewrites are POSIX shell syntax. On Windows, a call that names no shell is not rewritten either when the adapter has a shell field, because the tool picks its default there and pi-unified-exec falls back to PowerShell without Git Bash. Replicating each tool's shell discovery is not worth it. A command already starting with `rtk` is skipped, which saves a process and makes the legacy hook and this extension safe to run together. A working directory that does not exist is skipped before spawning. Otherwise Node reports it as `ENOENT`, which looks like a missing rtk and would wrongly count toward suspension.

### Own process runner instead of `pi.exec`
`rtk rewrite -- <command>` runs through `execFile` without a shell (`--` stops a command such as `-h` from being parsed as an rtk option and its help text from becoming the rewrite), with a 2 s timeout, `SIGKILL`, a 1 MiB output cap, and the call's abort signal. It returns exit code, signal, timeout, and start error as separate fields. This is the only way to tell a missing rtk or a crash from "no rewrite". It also keeps a signal exit with partial stdout from being taken as a rewrite.

### Exit-code mapping as a pure function
`interpretRewrite(original, run)` is the whole contract and is unit-tested exhaustively. Output is trimmed, which is safe because RTK itself trims commands, and inner newlines of multi-line rewrites are kept. Identical output counts as unchanged.

### Availability and suspension
`rtk --version` is checked in `session_start`, where awaiting it is allowed and costs about 10 ms. While rtk is unavailable, calls cost nothing. A call at least 30 s after the last check runs the check again, so installing rtk mid-session works without `/rtk on`. Three consecutive failures suspend rewriting for the session, so a hung rtk (for example a locked tracking database) cannot add 2 s to every command. `/rtk on` clears the suspension.

### State and reporting
All state is per extension runtime and reset in `session_start`: availability, the on/off switch, the suspension, and the counts. Nothing is stored in the session, because rewriting is not branch state. Warnings go through `ctx.ui.notify`. The footer status appears only while rewriting is not happening. The `RTK_DISABLED=1` environment variable is RTK's own convention and is read on every call.

## Risks / Trade-offs

- **A tool replaces `bash` with a non-POSIX interpreter** (for example @code-fixer-23/pi-bash-tooljack-nu). → The user sets `"bash": false`, documented in the README.
- **The model sees RTK's condensed output, not raw output.** → That is the purpose. RTK's own `rtk recall`/tee mechanisms recover elided output, and `/rtk off` or `RTK_DISABLED=1` gives raw output.
- **Another extension registers a tool named `exec_command` with different fields.** → The adapter only acts when the configured command field is a string. Otherwise the call is skipped, and the user can override the adapter.
- **`exec_command` sessions are long-lived.** RTK buffers output for filtering, so a streaming command rewritten by RTK may show output only at exit. → RTK leaves the usual streaming commands unchanged (`tail -f`, dev servers, REPLs return exit 1), and PTY sessions are never rewritten.
- **On Windows, `exec_command` calls without an explicit `shell` are not rewritten.** → A deliberate conservative choice; calls that name `bash` are still rewritten.
- **An invalid optional field in a configured adapter could otherwise drop a shell or PTY guard.** → Each configured entry is all or nothing: a single invalid field or unknown key ignores the entry and keeps the built-in adapter.
- **`tool_call` handlers run in extension load order.** A permission extension that runs after pi-rtk sees `rtk git push`, not `git push`, so a rule anchored at `^git` no longer matches. The legacy hook had the same property. → The README advises loading pi-rtk after permission extensions, or writing rules that tolerate an `rtk ` prefix.
- **The repository's typecheck targets Pi 1.1.0, while the installed `pi` is 1.3.0.** → Only stable APIs are used: `tool_call`, `session_start`, `registerCommand`, `getAllTools`, `ui.notify`, and `ui.setStatus`.

## Migration Plan

Install `@zeroclover/pi-rtk`, then remove `~/.pi/agent/extensions/rtk.ts` (or run `rtk init -g --agent pi --uninstall`). Running both is harmless, because commands that already start with `rtk` are skipped. Rollback: uninstall the package.
