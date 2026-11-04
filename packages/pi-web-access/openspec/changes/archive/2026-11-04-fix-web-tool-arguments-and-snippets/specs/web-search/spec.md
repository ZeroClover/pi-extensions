# Spec Delta

## ADDED Requirements

### Requirement: Null arguments count as omitted
`web_search` SHALL treat a top-level argument whose value is `null` as if it had not been sent, before any other handling of the arguments. An optional parameter sent as `null` SHALL take its default. A `null` `query` SHALL be a validation error that fails the call without contacting any provider.

#### Scenario: Null domain filters
- **WHEN** the model calls `web_search` with `query: "q"`, `domains: null` and `excludeDomains: null`
- **THEN** the provider receives the query `q` with no domain filter and no exclusion, and no result is dropped by a domain filter

#### Scenario: Null result count
- **WHEN** the model calls `web_search` with `query: "q"` and `maxResults: null`
- **THEN** the search runs with 5 results

#### Scenario: Null recency and provider
- **WHEN** the model calls `web_search` with `query: "q"`, `recency: null` and `provider: null`
- **THEN** the search runs on the default provider chain with no date filter

#### Scenario: Null argument from a codemode script
- **WHEN** a codemode script calls `tools.web_search({ query: "q", domains: null })`
- **THEN** the provider receives the query `q` with no domain filter and 5 results requested

#### Scenario: Null query
- **WHEN** the model calls `web_search` with `query: null`
- **THEN** the call fails with an error saying that `query` is required
- **AND** no provider is contacted

### Requirement: The system prompt names each tool once
When both tools are active and Pi's default system prompt is in use, its `<tools>` section SHALL give `web_search` and `web_fetch` exactly one entry each, and the text after the name that Pi prints SHALL NOT contain the tool's name.

#### Scenario: Tool list in the system prompt
- **WHEN** a model request is sent with both tools active and Pi's default system prompt
- **THEN** its `<tools>` section has exactly one line starting with `- web_search: ` and exactly one starting with `- web_fetch: `
- **AND** the text after that prefix does not contain `web_search` in the first line or `web_fetch` in the second

## MODIFIED Requirements

### Requirement: Stringified array arguments are accepted
When the model passes `domains` or `excludeDomains` as a JSON-encoded string instead of an array, the tool SHALL parse it into the array before validation. JSON text `null` SHALL count as omitted, and any other text that does not parse to an array SHALL become a single entry.

#### Scenario: Model sends a JSON string
- **WHEN** the model calls `web_search` with `domains: "[\"go.dev\", \"github.com\"]"`
- **THEN** the search runs with `domains` equal to `["go.dev", "github.com"]`

#### Scenario: JSON text null
- **WHEN** the model calls `web_search` with `query: "q"` and `domains: "null"`, or with `query: "q"` and `excludeDomains: "null"`
- **THEN** the provider receives the query `q` with no domain filter and no exclusion, and no result is dropped by a domain filter

#### Scenario: Text that is not a JSON array
- **WHEN** the model calls `web_search` with `query: "q"` and `domains: "example.com"`
- **THEN** the search runs with `domains` equal to `["example.com"]`
