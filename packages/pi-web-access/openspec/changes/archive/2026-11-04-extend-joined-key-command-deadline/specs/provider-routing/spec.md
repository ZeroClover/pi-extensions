# Spec Delta

## MODIFIED Requirements

### Requirement: Timeouts and cancellation
Each attempt, including the resolution of its credentials, SHALL be bounded by the provider's `timeoutMs`; a timeout counts as a failure. An attempt that begins while the provider's key command is running and before its deadline SHALL wait for that command instead of starting another, and the command's deadline SHALL move to `timeoutMs` from that moment. An attempt that begins as the command's deadline expires SHALL run the command again within its own `timeoutMs`, which may prompt the user a second time. When the tool call is aborted by Pi, the current request SHALL be cancelled and no further provider SHALL be attempted.

#### Scenario: Slow provider
- **WHEN** a provider does not answer within its `timeoutMs`
- **THEN** its attempt is recorded as a timeout and the next provider is tried

#### Scenario: Slow key command
- **WHEN** a provider's key comes from a command that has not finished within the provider's `timeoutMs`
- **THEN** the attempt is recorded as a timeout and the next provider is tried; unless the command's deadline has moved, the command is ended and the next call runs it again with its own full `timeoutMs`

#### Scenario: Key command already running
- **WHEN** an attempt begins while a key command started by a cancelled or parallel call is still running and has not reached its deadline
- **THEN** the command is not started again and its deadline moves to `timeoutMs` from that moment
- **AND** the attempt uses the key if the command finishes within the attempt's own `timeoutMs`, and is recorded as a timeout otherwise

#### Scenario: Key command reaching its deadline as the attempt begins
- **WHEN** an attempt begins just as the running key command's deadline expires, too late to move it
- **THEN** that command ends and the attempt runs the command again within its own `timeoutMs`, which may prompt the user a second time
- **AND** the attempt lasts its full `timeoutMs` if the new command does not finish, and is not failed by the old command's timeout

#### Scenario: Cancelled call and no later call
- **WHEN** a call is cancelled while its key command is running and no later attempt waits for the command
- **THEN** the command keeps its deadline: if it finishes in time its key serves the next call, otherwise it is ended

#### Scenario: User interrupts
- **WHEN** the user aborts the turn while a provider request is in flight
- **THEN** the request is cancelled and no other provider is contacted
