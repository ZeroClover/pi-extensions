# Spec Delta

## MODIFIED Requirements

### Requirement: Key expression syntax
`apiKey` SHALL accept a literal, `$NAME` or `${NAME}` (an environment variable), or `!command` (the trimmed standard output of the command run through the user's shell), with `$$` for a literal `$` and `$!` for a literal leading `!`. A key SHALL be resolved on first use in a session and cached for that session.

#### Scenario: Literal key
- **WHEN** `apiKey` is `sk-live-example`
- **THEN** requests carry `sk-live-example` unchanged, and a literal starting with `$` or `!` is written as `$$…` or `$!…`

#### Scenario: Key from a command
- **WHEN** `apiKey` is `!op read "op://Vault/Item/credential"`
- **THEN** the command runs the first time the provider is used and its output is the key for the rest of the session

#### Scenario: Command fails
- **WHEN** the command exits non-zero or prints nothing
- **THEN** the provider is skipped with a reason that quotes the command's error and `/web-access` shows the failure

#### Scenario: Command times out
- **WHEN** the command has not finished within the provider's `timeoutMs` of the last attempt that began waiting for it (for example while a password manager waits for approval)
- **THEN** the attempt fails as a timeout, `/web-access` shows that the key command timed out, and the next use of the provider runs the command again

#### Scenario: Environment variable
- **WHEN** `apiKey` is `$EXA_API_KEY` and that variable is set
- **THEN** its value is the key, and when it is unset the provider is skipped with a reason naming the variable
