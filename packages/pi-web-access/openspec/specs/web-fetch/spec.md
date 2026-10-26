# web-fetch Specification

## Purpose
The `web_fetch` tool: retrieves the content of one URL as text through whichever configured provider can deliver it, with offset-based continuation for long pages and an honest label of how the text was obtained.

## Requirements

### Requirement: The fetch tool is always registered
The extension SHALL register a tool named `web_fetch` whenever it loads, independent of the configuration file's content. When no provider that can fetch is configured or usable, a call SHALL fail with an error that names the configuration file path and says that no fetch provider is available.

#### Scenario: No configuration file
- **WHEN** Pi starts with the extension loaded and `<agent-dir>/pi-web-access.json` does not exist
- **THEN** `web_fetch` is listed among the session's tools
- **AND** calling it returns an error result naming `pi-web-access.json` and stating that no fetch provider is configured

### Requirement: Fetch parameters
`web_fetch` SHALL accept: `url` (string, required, `http` or `https`); `offset` (integer ≥ 0, default 0, a character position in the page text); `maxChars` (integer 1000–100000, default 20000); `provider` (string: the name of a configured provider). Every parameter SHALL carry a description.

#### Scenario: Unsupported URL scheme
- **WHEN** the model calls `web_fetch` with `url: "ftp://example.com/file"`
- **THEN** the call fails without contacting any provider and the error says only `http` and `https` URLs are supported

#### Scenario: Unknown provider name
- **WHEN** `provider` names a provider that is not in the configuration
- **THEN** the call fails with an error listing the configured provider names

### Requirement: Unified fetch result
The structured result SHALL be `{ provider, url, finalUrl?, title?, content, extraction, totalChars?, truncated, nextOffset?, crawledAt?, attempts, warnings, costUsd?, latencyMs }`, where `content` is markdown or plain text and `extraction` is `verbatim` or `model`. The tool SHALL declare this shape as its `outputSchema`, return it as `structuredContent`, and return the page text with a one-line header as `content`.

#### Scenario: Page within the limit
- **WHEN** a 6000-character page is fetched with default parameters
- **THEN** `content` holds the whole text, `truncated` is `false`, `nextOffset` is absent and `totalChars` is 6000

### Requirement: The page length is reported only when known
`totalChars` SHALL be present only when the result is `verbatim` and its text reaches the end of the page; a model's rendition has its own length, not the page's.

#### Scenario: Model-mediated fetch
- **WHEN** a page is fetched through a provider with `extraction: "model"`
- **THEN** the result has no `totalChars`

### Requirement: Long pages continue by offset
When the page text from `offset` onward exceeds `maxChars`, the tool SHALL return exactly `maxChars` characters, set `truncated` to `true` and `nextOffset` to `offset + maxChars`, and append a warning telling the model to call again with that offset. An `offset` at or beyond the end of the text SHALL return empty `content`, `truncated: false` and a warning that the offset is past the end.

#### Scenario: First and second page of a long document
- **WHEN** a 70 000-character page is fetched with `maxChars: 20000`, then again with `offset: 20000`
- **THEN** the first result has `truncated: true` and `nextOffset: 20000`
- **AND** the second result starts at character 20 000 of the same text and reports `nextOffset: 40000`

#### Scenario: Offset past the end
- **WHEN** a 6000-character page is fetched with `offset: 9000`
- **THEN** `content` is empty, `truncated` is `false` and `warnings` says the offset is past the end of the page

### Requirement: Uncertain page ends are reported as truncated
A provider that cannot tell whether its text was cut exactly at the end of the window (`sub2api-claude`) SHALL report `truncated: true` with `nextOffset` in that case; a following call then gets the offset-past-the-end result rather than losing text.

#### Scenario: Text that fills the window exactly
- **WHEN** `sub2api-claude` returns exactly `offset + maxChars` characters
- **THEN** the result has `truncated: true` and `nextOffset: offset + maxChars`

### Requirement: The extraction method is labelled
A result whose text came from the page itself (a crawler, a reader, or a server-side fetch tool) SHALL have `extraction: "verbatim"`. A result whose text was produced by a language model reading the page SHALL have `extraction: "model"` and a warning that the text is a model's rendition and may be incomplete.

#### Scenario: Verbatim provider
- **WHEN** the page is fetched through a provider that returns the page text
- **THEN** `extraction` is `verbatim` and no rendition warning is present

#### Scenario: Model-mediated provider
- **WHEN** the page is fetched through a provider that only exposes page opening inside a model's web-search tool
- **THEN** `extraction` is `model` and `warnings` says the content is a model's rendition

### Requirement: Freshness is reported when known
When the provider states when the page was crawled or how old its copy is, the result SHALL carry it as `crawledAt` (an ISO 8601 date-time or the provider's relative age text). The tool SHALL not claim freshness it cannot observe.

#### Scenario: Provider reports a cached copy
- **WHEN** the provider's response says the page was crawled three weeks ago
- **THEN** `crawledAt` carries that information

### Requirement: Empty content is a failure
A provider attempt that yields no text, or whose response announces a failure in its body while returning HTTP 200, SHALL count as a failed attempt for routing purposes.

#### Scenario: Provider returns a failure page as 200
- **WHEN** a provider answers HTTP 200 with a body that states the URL could not be fetched
- **THEN** the attempt is recorded as `error` with that reason and the next provider in the chain is tried
