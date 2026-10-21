# pi-rtk

Routes the shell commands Pi runs through [RTK](https://github.com/rtk-ai/rtk) so `git status`, `cargo test`, `rg`, `ls`, and other supported commands return compact, token-efficient output. Before each command runs, pi-rtk passes it to `rtk rewrite` and substitutes RTK's equivalent (`git status` → `rtk git status`). RTK's rule set decides what is rewritten; pi-rtk decides where and when it is safe.

- Rewrites Pi's `bash` tool, `exec_command` from [pi-unified-exec](https://www.npmjs.com/package/pi-unified-exec) and compatible plugins, plus any tool added in `pi-rtk.json`.
- Blocks commands that RTK denies with a reason, and never executes a deny message as a command.
- Never rewrites PTY sessions or commands targeting a non-POSIX shell.
- Leaves commands unchanged when `rtk` is missing, slow, or failing, and suspends a broken `rtk` for the rest of the session.

## Install

Published to npm as `@zeroclover/pi-rtk` and tagged `@zeroclover/pi-rtk@<version>` with release notes from `CHANGELOG.md`.

```bash
pi install npm:@zeroclover/pi-rtk             # install a published version for the user
pi -e ./packages/pi-rtk                       # try a repository checkout for one session
pi install /absolute/path/to/packages/pi-rtk  # install a repository checkout for the user
```

Requires `rtk` 0.25.0 or newer on `PATH`. Without it, pi-rtk warns once and runs commands unchanged.

**Coming from `rtk init --agent pi`:** remove `~/.pi/agent/extensions/rtk.ts`, or run `rtk init -g --agent pi --uninstall`. Keeping both is harmless because pi-rtk skips commands that already start with `rtk`, but the old hook only covers `bash`. Model-facing RTK instructions (`RTK.md`) from `rtk init` are separate and untouched by pi-rtk.

## Provides

| Kind | Name | Description |
|---|---|---|
| event | `tool_call` | Rewrites the command of every tool with an adapter, whether called by the model or a codemode script. |
| command | `/rtk` | Shows the current state, `rtk` version, configured adapters (marked `[not registered]` when no such tool is loaded), session counts of rewritten, unchanged, skipped, blocked, and failed calls, and the last failure. |
| command | `/rtk off` / `/rtk on` | Stops or resumes rewriting for this session. `on` also clears a suspension and re-checks `rtk`. Every new session starts on. |
| status | `rtk` | `RTK off` (`/rtk off` or `RTK_DISABLED=1`), else `RTK unavailable`, else `RTK suspended`, while commands are not being rewritten; empty otherwise. |

Any other argument to `/rtk` prints the usage.

## How a command is handled

1. If the tool has no adapter, rewriting is off (`/rtk off` or `RTK_DISABLED=1`), or rewriting is suspended, the command runs unchanged.
2. Skip rules leave the command unchanged without running `rtk` when:
   - the command is blank or already starts with `rtk`;
   - the call requests a PTY (`tty: true`), since RTK's output filtering breaks interactive programs;
   - `shell` is not bash, sh, zsh, dash, or ksh (for example `pwsh`, `cmd`, `fish`, `nu`), is `false`, or is another non-string value (`true` means the tool's default shell, like an omitted field);
   - on Windows, the adapter has a shell field but the call names no shell, because the tool's default on Windows can be PowerShell (pi-unified-exec without Git Bash);
   - the working directory does not exist.
3. `rtk rewrite <command>` runs without a shell, in the call's working directory, with a 2 s timeout. The command is passed as a single argument after `--`, so one starting with `-` is never parsed as an `rtk` option.

| rtk result | Effect |
|---|---|
| exit 0 or 3 with a different command | The tool runs the rewrite. Exit 3 only defers permission to the host, and Pi has no permission rules to apply. |
| exit 0 or 3 with empty or identical output, or exit 1 | The command runs unchanged (no RTK equivalent). |
| exit 2 with a message | The call is blocked with `rtk: <message>`. |
| exit 2 without a message | The command runs unchanged. RTK defers to the host's own deny rules. |
| timeout, crash, signal, start failure, other exit code | The command runs unchanged and the call counts as a failure. |

Cancelling a call (Escape) stops `rtk` and does not count as a failure.

## When rtk is missing or failing

- At session start, pi-rtk runs `rtk --version` (unless `RTK_DISABLED=1`). If `rtk` is missing, older than 0.25.0, or fails, pi-rtk warns once, shows `RTK unavailable`, and runs commands unchanged. The next adapted call at least 30 s after the last check checks again, so installing `rtk` during a session is picked up without `/rtk on`.
- Three consecutive failures suspend rewriting for the session, warn once with the last failure, and show `RTK suspended` so a hung `rtk` does not add 2 s to every command. Any normal answer from `rtk` resets the count. `/rtk on` or a new session ends the suspension.
- An internal error in pi-rtk never blocks a command; the command runs unchanged and a warning is shown.

## Configuration

Read from `<agent-dir>/pi-rtk.json` (default `~/.pi/agent/pi-rtk.json`) at session start; changes apply after `/reload` or in a new session. Without a configuration file, pi-rtk uses two built-in adapters:

| Tool | Command field | Shell field | PTY field | Working-directory field |
|---|---|---|---|---|
| `bash` (Pi, and plugins that replace it under the same name) | `command` | – | – | – |
| `exec_command` (pi-unified-exec, @chensl/pi-unified-exec, pi-exec-command, @howaboua/pi-codex-conversion) | `cmd` | `shell` | `tty` | `workdir` |

The `tools` object in `pi-rtk.json` adds adapters, replaces built-in ones, or disables an adapter with `false`:

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
| `commandField` | yes | Input field containing the shell command. Calls without a string in this field are ignored. |
| `shellField` | no | Input field naming the shell. Only `bash`, `sh`, `zsh`, `dash`, and `ksh` are rewritten; `false` (no shell) and, on Windows, calls with no shell specified are skipped. |
| `ttyField` | no | Boolean input field; `true` (PTY session) is never rewritten. |
| `cwdField` | no | Input field for the working directory, resolved against the session directory. |

In the example above, `bg_run` (from pi-background-tasks) and `bash_bg` (from pi-bg-shell) both run `command` in a POSIX shell without a PTY. Set `"bash": false` when your `bash` tool runs a non-POSIX shell (such as `@code-fixer-23/pi-bash-tooljack-nu`, which runs Nushell). Do not add tools that send keystrokes to an existing process (`write_stdin`, `terminal_send`), tools that always use a PTY (pi-smart-terminal's `terminal_exec`), or remote execution tools: an adapter cannot mark them, so their commands would be rewritten.

Each configuration error produces one warning at session start. An adapter entry with an unknown key or invalid field is ignored as a whole so a typo cannot strip the shell or PTY guard from a built-in adapter. Invalid JSON falls back to the built-in adapters.

Setting `RTK_DISABLED=1` in Pi's environment turns rewriting off (RTK's own switch). pi-rtk then never runs `rtk`, not even `rtk --version`, and `/rtk` reports `off (RTK_DISABLED=1)`.

## Not covered

- Your own `!` and `!!` commands run as typed. Rewriting them would require taking over Pi's `user_bash` execution, which would bypass sandbox and remote-shell extensions.
- Permission extensions also handle `tool_call`, in extension load order. One loaded after pi-rtk sees the rewritten command (`rtk git push`), so a rule anchored at the original program (`^git push`) will not match. Load pi-rtk after permission extensions, or write rules that accept an `rtk ` prefix.
- Output compaction and token statistics belong to RTK: `rtk gain` shows the savings, and `rtk recall <hash>` restores elided output.

## License

[AGPL-3.0-only](https://github.com/ZeroClover/pi-extensions/blob/master/LICENSE)
