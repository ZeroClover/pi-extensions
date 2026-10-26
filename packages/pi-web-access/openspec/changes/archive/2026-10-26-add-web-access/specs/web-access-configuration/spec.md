# Spec Delta

## Purpose

The `pi-web-access.json` configuration file: how providers, credentials and routing are declared, how invalid input is handled, and the `/web-access` command that shows the effective configuration.

## ADDED Requirements

### Requirement: Configuration file location
Configuration SHALL be read from `<agent-dir>/pi-web-access.json` (the directory returned by Pi's `getAgentDir()`) at session start. A missing file SHALL produce one informational notice naming the path and yield an empty provider set; changes take effect after `/reload` or a new session.

#### Scenario: No file
- **WHEN** the file does not exist
- **THEN** one notice says the file was not found and that both tools will fail until providers are configured

### Requirement: Configuration schema
The file SHALL be a JSON object with: `providers` (object: provider name → provider entry), `search` and `fetch` (optional arrays of provider names), and `rules` (optional array of `{ name, sites, search?, fetch? }`). Provider names SHALL be non-empty strings without whitespace.

#### Scenario: Full file
- **WHEN** the file declares six providers, `search`, `fetch` and two rules
- **THEN** all of them are applied and `/web-access` shows them

#### Scenario: Provider name with whitespace
- **WHEN** `providers` has the key `"my exa"`
- **THEN** that entry is dropped with one warning saying provider names cannot contain whitespace

### Requirement: Provider entry schema
A provider entry SHALL have `type` (one of `sub2api-search`, `sub2api-codex`, `sub2api-claude`, `sub2api-grok`, `deepseek`, `exa`) and MAY have `provider`, `model`, `apiKey`, `baseUrl`, `timeoutMs` and the type-specific options its provider spec defines. Keys outside this set SHALL be warned about and ignored.

#### Scenario: Unknown key
- **WHEN** a provider entry contains `"foo": 1`
- **THEN** one warning says `foo` is unknown for that provider and the entry is otherwise applied

### Requirement: Required fields and defaults per provider type
The four `sub2api-*` types SHALL require `provider` and `model` and derive `baseUrl` from the Pi provider. `deepseek` SHALL default `provider` to `deepseek` and `baseUrl` to `https://api.deepseek.com/v1`. `exa` SHALL default `apiKey` to `$EXA_API_KEY` and `baseUrl` to `https://api.exa.ai`. An entry missing a required field SHALL be dropped with one warning naming the field.

#### Scenario: Sub2API entry without a model
- **WHEN** a `sub2api-codex` entry has `provider` but no `model`
- **THEN** that provider is dropped and one warning names `model`

#### Scenario: Minimal DeepSeek entry
- **WHEN** an entry is `{ "type": "deepseek" }`
- **THEN** it is applied with Pi's `deepseek` provider as its credential source and the default base URL

### Requirement: Credential sources
A provider's key SHALL come from `apiKey` when present, otherwise from the Pi provider named by `provider` through Pi's model registry. The extension SHALL never read another extension's configuration files to obtain credentials.

#### Scenario: Pi provider credentials
- **WHEN** a Sub2API provider entry names `provider: "zero-aicoding-codex"`
- **THEN** requests use the API key, extra headers and base URL that Pi resolves for that provider's models

#### Scenario: Explicit key wins
- **WHEN** an entry has both `apiKey` and `provider`
- **THEN** requests use the key from `apiKey`

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
- **WHEN** the command has not finished within the provider's `timeoutMs` (for example while a password manager waits for approval)
- **THEN** the attempt fails as a timeout, `/web-access` shows that the key command timed out, and the next use of the provider runs the command again

#### Scenario: Environment variable
- **WHEN** `apiKey` is `$EXA_API_KEY` and that variable is set
- **THEN** its value is the key, and when it is unset the provider is skipped with a reason naming the variable

### Requirement: Validation and fallback
Invalid JSON or a non-object top level SHALL yield an empty provider set with one warning. A provider entry with an unknown `type`, a missing required field, or an invalid value SHALL be dropped with one warning naming it. A chain or rule entry that names an unknown provider SHALL be removed with a warning. Warnings SHALL be shown through the UI notification at session start.

#### Scenario: Invalid JSON
- **WHEN** the file is not valid JSON
- **THEN** no provider is configured and one warning names the file and the parse error

#### Scenario: Unknown provider type
- **WHEN** a provider entry has `type: "bing"`
- **THEN** that provider is dropped, one warning names it and the accepted types, and the other providers are kept

#### Scenario: Chain names a missing provider
- **WHEN** `search` is `["exa", "nope"]` and only `exa` is declared
- **THEN** the chain becomes `["exa"]` and one warning names `nope`

### Requirement: Rule validation
A rule without a non-empty `name`, left without any provider, or without a valid `sites` list SHALL be dropped with a warning, and each invalid entry of `sites` SHALL be ignored with a warning.

#### Scenario: Rule without a name
- **WHEN** a rule is `{ "sites": ["x.com"], "search": ["exa"] }`
- **THEN** the rule is dropped and one warning says a rule needs a name

### Requirement: Provider-specific defaults
Each provider type SHALL have a default `timeoutMs` (180 000 for `sub2api-grok`, 60 000 for every other type) and defaults for its type-specific options as its provider spec defines; `timeoutMs` SHALL accept integers from 1000 to 600 000.

#### Scenario: Out-of-range timeout
- **WHEN** a provider entry has `timeoutMs: 10`
- **THEN** the default applies and one warning names `timeoutMs`

### Requirement: Inspection command
The extension SHALL register `/web-access`, which prints every configured provider with its type, capabilities and credential status (`ready`, `not resolved yet`, or `failed: <reason>`), the effective `search` and `fetch` chains, and the rules with their patterns and chains, without printing any key or token.

#### Scenario: Status while idle
- **WHEN** the user runs `/web-access` before any tool call
- **THEN** the output lists the providers, shows `not resolved yet` for keys that come from commands, and contains no key material

#### Scenario: No configuration
- **WHEN** the user runs `/web-access` and no file exists
- **THEN** the output names the expected file path and says no provider is configured
