# Spec Delta

## Purpose

Lets the user see what pi-rtk is doing and turn rewriting off or on for a session, from Pi or from the environment.

## ADDED Requirements

### Requirement: Status command
`/rtk` without an argument SHALL report the state (`on`, `off (/rtk off)`, `off (RTK_DISABLED=1)`, `suspended: <reason>`, or `unavailable`), the rtk version or the reason it is unavailable, every adapter with its fields and whether the tool is registered in the session, the session counts of rewritten, unchanged, skipped, blocked, and failed calls, and the last failure if any.

#### Scenario: Adapter for a tool that is not installed
- **WHEN** `/rtk` runs in a session without pi-unified-exec
- **THEN** the `exec_command` adapter is listed with `[not registered]`

### Requirement: Session switch
`/rtk off` SHALL stop rewriting for the current session and show `RTK off`. `/rtk on` SHALL resume rewriting, clear a suspension, and check rtk again. Every new session starts on. Any other argument SHALL show the usage.

#### Scenario: Off and on
- **WHEN** the user runs `/rtk off`, then the model calls `bash` with `git status`
- **THEN** the command runs unchanged; after `/rtk on` the next call is rewritten

### Requirement: Environment switch
When `RTK_DISABLED=1` is set in Pi's environment, the extension SHALL leave every command unchanged without running RTK.

#### Scenario: Disabled by environment
- **WHEN** Pi runs with `RTK_DISABLED=1`
- **THEN** no command is rewritten and `/rtk` reports `off (RTK_DISABLED=1)`

### Requirement: Footer status
The footer status `rtk` SHALL show `RTK unavailable`, `RTK suspended`, or `RTK off` while commands are not being rewritten for that reason, and SHALL be empty while rewriting is active.

#### Scenario: Healthy session
- **WHEN** rtk is available and rewriting is on
- **THEN** the footer shows no rtk status
