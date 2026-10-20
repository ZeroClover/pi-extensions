# @zeroclover/pi-rtk

## 0.1.0

### Minor Changes

- First release: routes the shell commands Pi runs through RTK (`rtk rewrite`), so `git status`, `cargo test`, `rg` and the other commands RTK knows return compact, token-efficient output. It replaces the single-file hook that `rtk init --agent pi` installs; remove that hook with `rtk init -g --agent pi --uninstall`. Requires rtk 0.25.0 or newer on `PATH`.
- Covers Pi's `bash` tool and the `exec_command` tool of pi-unified-exec and compatible exec plugins, including calls made from codemode scripts. Other exec tools are added, replaced or removed in `pi-rtk.json` in Pi's agent directory.
- Blocks a command when RTK denies it with a reason, and never runs a deny message as a command. Never rewrites PTY sessions, non-POSIX shells, or Windows calls that name no shell.
- Leaves every command unchanged whenever rtk is missing, too old, slow or failing. A missing rtk is checked again after 30 seconds, and three consecutive rtk failures suspend rewriting for the session.
- `/rtk` shows the state, the adapters and the session counts; `/rtk off` and `/rtk on` turn rewriting off or on for the session, and `RTK_DISABLED=1` turns it off entirely.
