# Spec Delta

## Purpose

Defines which tools have their commands rewritten and how the command, shell, PTY, and working-directory inputs of each tool are found, so that Pi's bash, exec plugins, and user-configured tools are all covered without unsafe rewrites.

## ADDED Requirements

### Requirement: Built-in adapters
The extension SHALL rewrite the `command` field of `bash`, and the `cmd` field of `exec_command` using `shell`, `tty`, and `workdir` as that tool's shell, PTY, and working-directory fields. Tools without an adapter SHALL never be touched.

#### Scenario: Unknown tool
- **WHEN** a tool named `bg_run` is called with `command: "git status"` and no adapter exists for it
- **THEN** its input is unchanged and RTK is not run

#### Scenario: Input that does not match the adapter
- **WHEN** a tool named `exec_command` is called without a string `cmd` field
- **THEN** its input is unchanged and RTK is not run

### Requirement: Skip rules
A call SHALL NOT be sent to RTK when its command is missing, blank, or already starts with `rtk`; when its PTY field is `true`; when its shell field is `false`, another non-string value other than `true` (which, like an omitted field, means the tool's default shell), or names a shell other than bash, sh, zsh, dash, or ksh (compared by basename, case-insensitively, ignoring `.exe`); or, on Windows, when the adapter has a shell field and the call names no shell.

#### Scenario: PTY session
- **WHEN** `exec_command` is called with `cmd: "ssh host"` and `tty: true`
- **THEN** the command is not rewritten

#### Scenario: Non-POSIX shell
- **WHEN** `exec_command` is called with `shell: "pwsh"` or `shell: "C:\\Windows\\System32\\cmd.exe"`
- **THEN** the command is not rewritten

#### Scenario: Default shell on Windows
- **WHEN** on Windows `exec_command` is called without `shell`, where pi-unified-exec may fall back to PowerShell
- **THEN** the command is not rewritten

#### Scenario: POSIX shell path
- **WHEN** `exec_command` is called with `shell: "/bin/zsh"`
- **THEN** the command is sent to RTK

#### Scenario: Already an RTK command
- **WHEN** the command is `rtk git status`
- **THEN** RTK is not run

### Requirement: Working directory
RTK SHALL run in the session's working directory, or in the tool's working-directory field resolved against it when the adapter has one and the field is a non-empty string. When that directory does not exist, the call SHALL be skipped and SHALL NOT count as an RTK failure.

#### Scenario: Relative workdir
- **WHEN** `exec_command` is called with `workdir: "packages"` in session directory `/repo`
- **THEN** RTK runs in `/repo/packages`

#### Scenario: Missing workdir
- **WHEN** the resolved working directory does not exist
- **THEN** the command is not rewritten and the failure count is unchanged

### Requirement: Configured adapters
At session start the extension SHALL read `<agent-dir>/pi-rtk.json`. Its `tools` object maps a tool name to an adapter (`commandField` required; `shellField`, `ttyField`, `cwdField` optional) that adds or replaces that tool's adapter, or to `false`, which removes it. Each problem SHALL produce one warning; an entry with an invalid field or an unknown key SHALL be ignored as a whole, leaving that tool at its built-in state. A missing file means the built-in adapters.

#### Scenario: Add a background-task tool
- **WHEN** the file contains `{"tools": {"bg_run": {"commandField": "command"}}}`
- **THEN** `bg_run` calls are rewritten in addition to the built-in tools

#### Scenario: Disable bash rewriting
- **WHEN** the file contains `{"tools": {"bash": false}}`
- **THEN** `bash` calls are never rewritten

#### Scenario: Invalid entry
- **WHEN** an entry lacks `commandField`
- **THEN** a warning names the entry and the other entries still apply

#### Scenario: Invalid optional field
- **WHEN** the entry `exec_command` sets `ttyField` to a number
- **THEN** the whole entry is ignored and the built-in `exec_command` adapter, PTY guard included, still applies
