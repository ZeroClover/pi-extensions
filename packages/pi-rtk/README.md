# pi-rtk

Routes the shell commands Pi runs through [RTK](https://github.com/rtk-ai/rtk), so that `git status`, `cargo test`, `rg`, `ls` and the other commands RTK knows return compact, token-efficient output. Before each command runs, pi-rtk asks `rtk rewrite` for RTK's equivalent and substitutes it (`git status` → `rtk git status`). RTK's rule set decides what is rewritten; pi-rtk decides where and when it is safe.

pi-rtk replaces the single-file hook that `rtk init --agent pi` installs. It covers Pi's `bash` tool and the `exec_command` tool of [pi-unified-exec](https://www.npmjs.com/package/pi-unified-exec) and compatible exec plugins, including calls made from codemode scripts. Other exec tools can be added in a configuration file. pi-rtk also:

- blocks commands that RTK denies with a reason, and never runs a deny message as a command;
- never rewrites PTY sessions or commands for a non-POSIX shell;
- leaves the command unchanged whenever rtk is missing, slow, or failing;
- stops calling a broken rtk for the rest of the session.

## Install

Releases are published to npm as `@zeroclover/pi-rtk`, versioned independently of the other packages in this repository. Each release is tagged `@zeroclover/pi-rtk@<version>`, and its notes are the matching section of the package's `CHANGELOG.md`.

```bash
pi install npm:@zeroclover/pi-rtk             # install a published version for the user
pi -e ./packages/pi-rtk                       # try a repository checkout for one session
pi install /absolute/path/to/packages/pi-rtk  # install a repository checkout for the user
```

Requires `rtk` 0.23.0 or newer on `PATH`. Without it, pi-rtk warns once and commands run unchanged.

**Coming from `rtk init --agent pi`:** remove `~/.pi/agent/extensions/rtk.ts`, or run `rtk init -g --agent pi --uninstall`. Keeping both does no harm, because pi-rtk skips commands that already start with `rtk`, but the old hook only sees `bash`. The model-facing RTK instructions (`RTK.md`) from `rtk init` are separate, and pi-rtk does not change them.

## Provides

| Kind | Name | Description |
|---|---|---|
| event | `tool_call` | Rewrites the command of every tool that has an adapter, whether the model or a codemode script calls it. |
| command | `/rtk` | Shows the state, the rtk version, every adapter (marked `[not registered]` when no such tool is loaded), the session counts of rewritten, unchanged, skipped, blocked, and failed calls, and the last failure. |
| command | `/rtk off` / `/rtk on` | Stops or resumes rewriting for this session. `on` also ends a suspension and checks rtk again. Every new session starts on. |
| status | `rtk` | `RTK unavailable`, `RTK suspended`, or `RTK off` while commands are not being rewritten; empty otherwise. |

Any other argument to `/rtk` prints the usage.

## How a command is handled

1. The tool has no adapter, rewriting is off (`/rtk off`, `RTK_DISABLED=1`), or rewriting is suspended: the command runs unchanged.
2. Skip rules leave the command unchanged without running rtk. They apply when:
   - the command is blank or already starts with `rtk`;
   - the call asks for a PTY (`tty: true`), because RTK filters output, which breaks interactive programs;
   - the `shell` is not bash, sh, zsh, dash, or ksh (for example `pwsh`, `cmd`, `fish`, `nu`), or is `false`;
   - on Windows, the tool has a shell field but the call names no shell, because the tool's default there can be PowerShell (pi-unified-exec without Git Bash);
   - the working directory does not exist.
3. `rtk rewrite <command>` runs without a shell, in the call's working directory, with a 2 s timeout. The command is passed as a single argument after `--`, so one that starts with `-` is never taken for an rtk option.

| rtk result | Effect |
|---|---|
| exit 0 or 3 with a different command | The tool runs the rewrite. Exit 3 only defers permission to the host, and Pi has no permission rules to apply. |
| exit 0 or 3 with empty or identical output, or exit 1 | The command runs unchanged (no RTK equivalent). |
| exit 2 with a message | The call is blocked with `rtk: <message>`. |
| exit 2 without a message | The command runs unchanged. RTK defers to the host's own deny rules. |
| timeout, crash, signal, start failure, other exit code | The command runs unchanged and the call counts as a failure. |

A cancelled call (Escape) stops rtk and is not counted as a failure.

## When rtk is missing or failing

- At session start pi-rtk runs `rtk --version`. If rtk is missing, too old, or fails, it warns once, shows `RTK unavailable`, and runs commands unchanged at no cost. The next call with an adapter, 30 s or more after the last check, checks again, so installing rtk during a session is picked up without `/rtk on`.
- Three consecutive failures suspend rewriting for the session. pi-rtk warns once with the last failure and shows `RTK suspended`. This keeps a hung rtk from adding 2 s to every command. Any normal answer from rtk resets the count. `/rtk on` or a new session ends the suspension.
- An internal error in pi-rtk never blocks a command. The command runs unchanged and a warning is shown.

## Configuration

`<agent-dir>/pi-rtk.json` (by default `~/.pi/agent/pi-rtk.json`) is read at session start, and changes apply after `/reload` or in a new session. Without the file, pi-rtk uses its built-in adapters:

| Tool | Command field | Shell field | PTY field | Working-directory field |
|---|---|---|---|---|
| `bash` (Pi, and plugins that replace it under the same name) | `command` | – | – | – |
| `exec_command` (pi-unified-exec, @chensl/pi-unified-exec, pi-exec-command, @howaboua/pi-codex-conversion) | `cmd` | `shell` | `tty` | `workdir` |

The `tools` object adds an adapter for another tool, replaces a built-in one, or removes one with `false`:

```json
{
	"tools": {
		"bg_run": { "commandField": "command" },
		"bash_bg": { "commandField": "command" },
		"bash": false
	}
}
```

| Adapter key | Required | Meaning |
|---|---|---|
| `commandField` | yes | Input field that holds the shell command. A call without a string in this field is left alone. |
| `shellField` | no | Input field that names the shell. Only bash, sh, zsh, dash, and ksh are rewritten; `false` (no shell), and on Windows a call that names no shell, are never rewritten. |
| `ttyField` | no | Boolean input field; `true` (a PTY session) is never rewritten. |
| `cwdField` | no | Input field with the working directory, resolved against the session directory. |

`bg_run` is the tool of pi-background-tasks and `bash_bg` the tool of pi-bg-shell; both run `command` through a POSIX shell without a PTY. Use `"bash": false` when your `bash` tool is not a POSIX shell (for example @code-fixer-23/pi-bash-tooljack-nu, which runs Nushell). Do not add tools that send keystrokes to a running process (`write_stdin`, `terminal_send`), tools whose every call runs in a PTY (pi-smart-terminal's `terminal_exec`), or tools that run commands remotely: an adapter cannot mark them, so their commands would be rewritten. Each problem produces one warning at session start. An entry with an unknown key or an invalid field is ignored as a whole, so a typo can never drop the shell or PTY guard of a built-in adapter. Invalid JSON means the built-in adapters.

`RTK_DISABLED=1` in Pi's environment turns rewriting off; this is RTK's own switch. `/rtk` then reports `off (RTK_DISABLED=1)`.

## Not covered

- Your own `!` and `!!` commands run exactly as typed. Rewriting them would require taking over Pi's `user_bash` execution, and that would bypass sandbox and remote-shell extensions.
- Permission extensions also handle `tool_call`, in extension load order. One that runs after pi-rtk sees the rewritten command (`rtk git push`), so a rule anchored at the original program (`^git push`) does not match it. Load pi-rtk after such extensions, or write rules that accept an `rtk ` prefix.
- Output compaction and token statistics belong to RTK. `rtk gain` shows the savings, and `rtk recall <hash>` restores elided output.
