# Spec Delta

## ADDED Requirements

### Requirement: Null arguments count as omitted
An optional `web_fetch` parameter sent as `null` SHALL behave as if it had not been sent. A `null` `url` SHALL fail the call without contacting any provider.

#### Scenario: Null optional parameters
- **WHEN** the model calls `web_fetch` with a valid `url` and `offset: null`, `maxChars: null` and `provider: null`
- **THEN** the page is fetched through the default chain and the result starts at character 0 with the default window

#### Scenario: Null URL
- **WHEN** the model calls `web_fetch` with `url: null`
- **THEN** the call returns an error result and no provider is contacted
