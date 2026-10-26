# Spec Delta

## Purpose

The `web_search` tool: the single, provider-neutral way the model searches the web, with a small declaration, unified parameters, a unified result schema, and client-side clean-up that every provider's results pass through.

## ADDED Requirements

### Requirement: The search tool is always registered
The extension SHALL register a tool named `web_search` whenever it loads, independent of the configuration file's content. When no provider that can search is configured or usable, a call SHALL fail with an error that names the configuration file path and says that no search provider is available.

#### Scenario: No configuration file
- **WHEN** Pi starts with the extension loaded and `<agent-dir>/pi-web-access.json` does not exist
- **THEN** `web_search` is listed among the session's tools
- **AND** calling it returns an error result naming `pi-web-access.json` and stating that no search provider is configured

### Requirement: Search parameters
`web_search` SHALL accept: `query` (string, required); `domains` (string array: hostnames with optional path prefix, e.g. `github.com`, `go.dev/doc`, `x.com/golang`, or a suffix such as `.cn`); `excludeDomains` (string array); `recency` (one of `day`, `week`, `month`, `year`); `maxResults` (integer 1–20, default 5); `includeContent` (boolean, default false); `provider` (string: the name of a configured provider). Every parameter SHALL carry a description.

#### Scenario: Minimal call
- **WHEN** the model calls `web_search` with only `query`
- **THEN** the search runs with the default provider chain, 5 results, no filters, and no page content

#### Scenario: Unknown provider name
- **WHEN** `provider` names a provider that is not in the configuration
- **THEN** the call fails with an error listing the configured provider names

### Requirement: `site:` operators in the query count as domain filters
A `site:<host>` or `site:<host>/<path>` token in `query` SHALL be removed from the query text and treated as an entry of `domains`; a `-site:<host>` token SHALL be treated as an entry of `excludeDomains`.

#### Scenario: Model writes a site operator
- **WHEN** the model calls `web_search` with `query: "rust async runtime site:reddit.com"`
- **THEN** the provider receives the query `rust async runtime` with `reddit.com` as a domain filter
- **AND** the site rule for `reddit.com`, if any, applies

### Requirement: Unified search result
The structured result SHALL be `{ provider, query, answer?, results, attempts, warnings, costUsd?, latencyMs }`. Each entry of `results` SHALL be `{ title, url, snippet, content?, publishedAt?, score? }` with `publishedAt` an ISO 8601 date when the provider reported one. `provider` SHALL name the configured provider whose results are returned. The tool SHALL declare this shape as its `outputSchema` and return it as `structuredContent`, with a markdown rendering of the same data as `content`.

#### Scenario: Result shape
- **WHEN** a search succeeds on a provider that returns titles, URLs, snippets and dates
- **THEN** `structuredContent.results[i]` carries `title`, `url`, `snippet` and `publishedAt` for each result and `structuredContent.provider` is that provider's configured name

#### Scenario: Provider that produces an answer
- **WHEN** the search runs on a provider that generates an answer text with citations
- **THEN** `answer` holds the answer text and `results` holds the cited pages

#### Scenario: Cost reported by the provider
- **WHEN** the provider's response states the cost of the request
- **THEN** `costUsd` carries that value, otherwise it is absent

### Requirement: Domain filters are enforced client-side
Regardless of how a provider applies `domains` and `excludeDomains`, the tool SHALL remove every result whose URL host does not match an entry of `domains` (when given) or matches an entry of `excludeDomains`, using the site-pattern matching defined in `provider-routing`. When results were removed from a provider whose own filter is not authoritative, `warnings` SHALL say how many were dropped.

#### Scenario: Soft provider filter leaks another host
- **WHEN** `domains` is `["x.com"]` and the provider returns a result from `codedtx.com`
- **THEN** that result is not in `results` and `warnings` mentions one dropped result

#### Scenario: Subdomains match
- **WHEN** `domains` is `["github.com"]` and a result comes from `gist.github.com`
- **THEN** the result is kept

#### Scenario: Path-prefix filter
- **WHEN** `domains` is `["go.dev/doc"]` and results come from `https://go.dev/doc/devel/release` and `https://go.dev/blog/go1.27`
- **THEN** only the first is kept

### Requirement: Path exclusions are never widened to a host
A provider that can exclude only whole hosts SHALL receive only the entries of `excludeDomains` without a path; path exclusions SHALL be enforced on the results alone, so that excluding `go.dev/doc/install` never removes the rest of `go.dev`.

#### Scenario: Path exclusion on a host-only provider
- **WHEN** `domains` is `["go.dev/doc"]`, `excludeDomains` is `["go.dev/doc/install"]`, and the provider excludes only whole hosts
- **THEN** the provider receives no exclusion of `go.dev`, and results under `https://go.dev/doc/install` are removed from `results`

### Requirement: Results are deduplicated by normalised URL
Two results SHALL be considered the same page when their URLs are equal after lower-casing scheme and host, removing the fragment, and removing `utm_*`, `fbclid` and `gclid` query parameters; the first occurrence SHALL be kept and `results` SHALL contain at most `maxResults` entries.

#### Scenario: Tracking parameter and fragment
- **WHEN** a provider returns `https://go.dev/dl/?utm_source=openai`, `https://go.dev/dl/#1` and `https://go.dev/dl/`
- **THEN** `results` contains one entry for `https://go.dev/dl/`

### Requirement: Result text is bounded
Each `snippet` SHALL be at most 500 characters and each `content` at most 4000 characters; truncated text SHALL end with a marker and `warnings` SHALL say that content was truncated and that `web_fetch` returns the full page.

#### Scenario: Provider returns a whole page as snippet
- **WHEN** a provider returns a 27 000-character snippet for a result
- **THEN** the result's `snippet` is 500 characters plus the marker, and `warnings` names `web_fetch` for the full page

### Requirement: The search declaration stays small
The `description` and the JSON of `parameters` of `web_search` and of `web_fetch` together SHALL total at most 4000 characters, so that both tools fit into Pi's codemode inline budget alongside other tools.

#### Scenario: Declaration size
- **WHEN** a model request is sent with both tools available
- **THEN** the combined length of the two tools' descriptions and parameter schemas in that request is at most 4000 characters

### Requirement: The codemode declaration stays small
In codemode, where a tool's declaration also renders its result type, the declarations of `web_search` and `web_fetch` together SHALL occupy at most 5000 characters of the codemode tool description.

#### Scenario: Codemode declaration size
- **WHEN** Pi runs with codemode in `only` mode and both tools active
- **THEN** the two declarations inside the codemode description sent to the model total at most 5000 characters

### Requirement: Stringified array arguments are accepted
When the model passes `domains` or `excludeDomains` as a JSON-encoded string instead of an array, the tool SHALL parse it into the array before validation.

#### Scenario: Model sends a JSON string
- **WHEN** the model calls `web_search` with `domains: "[\"go.dev\", \"github.com\"]"`
- **THEN** the search runs with `domains` equal to `["go.dev", "github.com"]`
