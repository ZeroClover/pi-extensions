# Spec Delta

## Purpose

The `deepseek` provider type: DeepSeek's Search and Fetch tool APIs mapped onto the unified search and fetch contracts, including the query-operator composition the API requires and the clean-up its responses need.

## ADDED Requirements

### Requirement: DeepSeek endpoints and credentials
A provider of type `deepseek` SHALL search through `POST <baseUrl>/tools/search` and fetch through `POST <baseUrl>/tools/fetch`, with `baseUrl` defaulting to `https://api.deepseek.com/v1`, authenticated with a bearer token taken from the configured key expression or, when none is given, from the Pi provider named by `provider` (default `deepseek`).

#### Scenario: Key from Pi's DeepSeek provider
- **WHEN** no `apiKey` is configured and Pi holds a key for its `deepseek` provider
- **THEN** search and fetch requests carry that key as `Authorization: Bearer`

#### Scenario: No key anywhere
- **WHEN** neither a key expression nor a Pi key is available
- **THEN** the provider is skipped with the reason `no credentials`

### Requirement: Filters become query operators
`domains` SHALL be rendered as `site:` terms (hostnames) joined by `OR`, the entries of `excludeDomains` without a path as `-site:` terms, and `recency` as `after:<date>` computed from the current date, appended to the query text. Because DeepSeek applies `site:` as a preference, a search with `domains` SHALL request at least three times `maxResults` (at most 50) so that client-side host filtering still yields enough results.

#### Scenario: Domain filter
- **WHEN** the model searches `rust async runtime` with `domains: ["reddit.com", "news.ycombinator.com"]` and `maxResults: 5`
- **THEN** the request's `query` is `rust async runtime site:reddit.com OR site:news.ycombinator.com` and its `count` is 15

#### Scenario: Recency
- **WHEN** `recency: "month"` is requested on 2026-10-23
- **THEN** the query ends with `after:2026-09-23`

### Requirement: The 128-character query budget is respected
When the composed query exceeds 128 characters, operators SHALL be dropped in the order `-site:`, `site:`, `after:` until it fits, the dropped filters SHALL still be enforced client-side, and `warnings` SHALL say which filters were moved client-side. Query text that alone exceeds 128 characters SHALL be cut at a word boundary with a warning.

#### Scenario: Too many domains
- **WHEN** the query text plus six `site:` terms exceeds 128 characters
- **THEN** the request carries as many `site:` terms as fit, the remaining domains are enforced on the results, and `warnings` mentions them

### Requirement: Search response mapping
Each DeepSeek result SHALL map `title`, `url`, `snippet` → `snippet`, `date` → `publishedAt`, `rerank_score` → `score`; with `includeContent`, the request SHALL set `need_content: true` and the result's `content` SHALL become `content`, falling back to `summary` when `content` is empty.

#### Scenario: Content requested
- **WHEN** `includeContent: true`
- **THEN** the request has `need_content: true` and each result's `content` holds the page text DeepSeek returned, bounded by the unified content limit

### Requirement: Fetch response clean-up
A fetch SHALL send `{ "url" }` and return `title` and `content` with DeepSeek's backslash escapes removed from punctuation (`\#`, `\.`, `\-`, `\/`, `\:` and similar) and `extraction: "verbatim"`; a non-success status SHALL be a failed attempt whose reason includes DeepSeek's error message.

#### Scenario: Escaped markdown
- **WHEN** DeepSeek returns `\# Release History\n\nUse\: git fetch \-\-tags`
- **THEN** `content` is `# Release History\n\nUse: git fetch --tags`

#### Scenario: Unfetchable URL
- **WHEN** DeepSeek answers HTTP 404 with `failed to fetch URL`
- **THEN** the attempt is recorded as an error with that message and routing continues to the next provider

### Requirement: Error classification
HTTP 401 and 402 SHALL be reported as credential or balance problems, 429 and 5xx as transient; every one of them is a failed attempt and the reason text SHALL include the status code.

#### Scenario: Insufficient balance
- **WHEN** DeepSeek answers HTTP 402
- **THEN** the attempt's reason says `402` and that the account balance is insufficient
