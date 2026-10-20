# rtk-availability Specification

## Purpose
Detects whether a usable rtk is installed and stops paying for rtk calls when it is missing or keeps failing, without ever blocking Pi's startup or the user's commands.

## Requirements

### Requirement: Check at session start
Unless `RTK_DISABLED=1` is set, the extension SHALL run `rtk --version` (2-second timeout) when a session starts, not when the extension loads. rtk is usable when the command exits 0 with version 0.25.0 or newer, or with output that contains no version. Otherwise the extension SHALL warn once, set the footer status `RTK unavailable`, and leave commands unchanged.

#### Scenario: rtk not installed
- **WHEN** `rtk` is not on `PATH` at session start
- **THEN** one warning explains that commands run unchanged and the footer shows `RTK unavailable`

#### Scenario: rtk too old
- **WHEN** `rtk --version` prints `rtk 0.24.9`
- **THEN** the warning says rtk is too old and names the minimum version

#### Scenario: Extension loaded without a session
- **WHEN** Pi loads the extension without starting a session
- **THEN** no process is started

### Requirement: Recheck an unavailable rtk
While rtk is unavailable, a tool call with an adapter SHALL check rtk again when at least 30 seconds have passed since the last check, without a new warning. When the check succeeds, the call and later calls SHALL be rewritten and the footer status cleared.

#### Scenario: Parallel calls after the interval
- **WHEN** several calls arrive at once after the recheck interval
- **THEN** only one of them runs `rtk --version`

#### Scenario: rtk installed during the session
- **WHEN** rtk becomes available and a `bash` call arrives 30 seconds or more after the last check
- **THEN** that call is rewritten

#### Scenario: Within the recheck interval
- **WHEN** a call arrives less than 30 seconds after the last failed check
- **THEN** rtk is not run and the command is unchanged

### Requirement: Suspend after repeated failures
After 3 consecutive RTK failures (timeouts, kills, failures to start, unexpected exit codes), the extension SHALL stop running RTK for the session, warn once with the last failure, and show `RTK suspended`. Any call RTK answers normally SHALL reset the count. `/rtk on` and a new session SHALL end the suspension.

#### Scenario: rtk keeps timing out
- **WHEN** three calls in a row time out
- **THEN** one warning is shown, later calls do not run RTK, and the footer shows `RTK suspended`

#### Scenario: Intermittent failure
- **WHEN** failures alternate with normal answers
- **THEN** rewriting is never suspended
