# Spec Delta

## Purpose

Sends the shell command of a tool call through `rtk rewrite` before the tool runs, so that commands with an RTK equivalent produce compact output, while any problem leaves the command exactly as the model wrote it.

## ADDED Requirements

### Requirement: Rewrite before execution
Before a tool with an adapter runs, the extension SHALL pass its command to `rtk rewrite` as a single argument after `--`, without a shell, in the call's working directory, and SHALL replace the command field with RTK's rewrite when RTK provides one. This SHALL apply equally to calls made by the model and to calls made from other tools, such as codemode scripts.

#### Scenario: Direct bash call
- **WHEN** the model calls `bash` with `command: "git status"` and RTK prints `rtk git status` with exit code 3
- **THEN** the tool runs `rtk git status`

#### Scenario: Nested codemode call
- **WHEN** a codemode script calls `exec_command` with `cmd: "git log --oneline -3"`
- **THEN** the nested call runs RTK's rewrite of that command

#### Scenario: Command with shell metacharacters
- **WHEN** the command is `git commit -m "a && b"`
- **THEN** RTK receives that exact string as one argument and no shell interprets it

#### Scenario: Command that looks like an option
- **WHEN** the command is `-h`
- **THEN** RTK does not treat it as its own option, and the command runs unchanged instead of RTK's help text

### Requirement: Exit-code contract
The extension SHALL interpret `rtk rewrite` as follows: exit 0 or 3 with output different from the original command replaces the command; exit 1, or exit 0 or 3 with empty or identical output, leaves it unchanged; exit 2 with output blocks the call with that output as the reason; exit 2 without output leaves it unchanged.

#### Scenario: No RTK equivalent
- **WHEN** RTK exits 1 for `vim notes.txt`
- **THEN** the tool runs `vim notes.txt` unchanged

#### Scenario: Deny with a reason
- **WHEN** RTK exits 2 and prints a message
- **THEN** the tool call is blocked with reason `rtk: <message>` and the message is never executed as a command

#### Scenario: Deny deferred to the host
- **WHEN** RTK exits 2 without output
- **THEN** the command runs unchanged

#### Scenario: Multi-line rewrite
- **WHEN** RTK rewrites a two-line command into two rewritten lines followed by a newline
- **THEN** the command becomes the two lines without the trailing newline

### Requirement: Fail open
Every problem other than an RTK deny SHALL leave the command unchanged and let the tool run: RTK timing out (2 seconds), being killed, failing to start (including arguments the process API refuses, such as a NUL byte), exiting with another code, or an internal error in the extension. The `tool_call` handler SHALL never throw.

#### Scenario: RTK hangs
- **WHEN** `rtk rewrite` does not finish within 2 seconds
- **THEN** it is killed and the original command runs

#### Scenario: RTK crashes
- **WHEN** `rtk rewrite` is killed by a signal after printing partial output
- **THEN** the partial output is discarded and the original command runs

#### Scenario: Internal error
- **WHEN** the extension throws while handling a call
- **THEN** the tool runs with its original input and a warning is shown

### Requirement: Cancellation
When the tool call is cancelled while `rtk rewrite` runs, the extension SHALL stop RTK, leave the input unchanged, and not count the call as an RTK failure.

#### Scenario: User aborts during rewrite
- **WHEN** the call's abort signal fires during `rtk rewrite`
- **THEN** RTK is stopped and the failure count does not increase
