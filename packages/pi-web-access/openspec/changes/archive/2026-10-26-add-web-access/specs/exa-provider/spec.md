# Spec Delta

## Purpose

The `exa` provider type: Exa's `/search` and `/contents` endpoints mapped onto the unified search and fetch contracts, with the search type, freshness and snippet choices that keep it cheap and its results readable.

## ADDED Requirements

### Requirement: Exa endpoints and credentials
A provider of type `exa` SHALL search through `POST <baseUrl>/search` and fetch through `POST <baseUrl>/contents`, with `baseUrl` defaulting to `https://api.exa.ai`, authenticated with the `x-api-key` header from the configured key expression (default `$EXA_API_KEY`).

#### Scenario: Missing key
- **WHEN** no key expression resolves to a value
- **THEN** the provider is skipped with the reason `no credentials` and no request is sent

#### Scenario: Rejected key
- **WHEN** Exa answers HTTP 401 or 402
- **THEN** the attempt's reason says the key was rejected or missing (`401`/`402`) and routing continues

### Requirement: Exa search request
A search SHALL send `{ query, type, numResults, contents: { highlights: { maxCharacters: 400 } } }` with `type` from the provider option `searchType` (`lite` default, or `auto`), `includeDomains`/`excludeDomains` copied from `domains`/`excludeDomains` (paths kept), `startPublishedDate` from `recency`, and `category` from the provider option when set. With `includeContent`, the request SHALL add `contents.text: { maxCharacters: 4000 }`.

#### Scenario: Default search
- **WHEN** the model searches `sqlite wal mode` with `maxResults: 5`
- **THEN** the request is `{ "query": "sqlite wal mode", "type": "lite", "numResults": 5, "contents": { "highlights": { "maxCharacters": 400 } } }`

#### Scenario: Path filter and recency
- **WHEN** the model searches with `domains: ["go.dev/doc"]` and `recency: "month"` on 2026-10-23
- **THEN** the request carries `includeDomains: ["go.dev/doc"]` and `startPublishedDate: "2026-09-23"`

#### Scenario: Content requested
- **WHEN** `includeContent: true`
- **THEN** the request's `contents` has both `highlights` and `text: { "maxCharacters": 4000 }`

### Requirement: Recency drops undated pages on Exa
Because Exa's `startPublishedDate` excludes pages without a publication date, a search with `recency` SHALL add a warning saying that undated pages are excluded by Exa when a date filter is used.

#### Scenario: Recency warning
- **WHEN** a search with `recency: "week"` runs on Exa
- **THEN** `warnings` contains that note even when results are returned

### Requirement: Exa search response mapping
Each result SHALL map `title` (falling back to the URL when empty), `url`, the joined `highlights` as `snippet` (falling back to `summary`, then to the start of `text`), `text` as `content`, and the date part of `publishedDate` as `publishedAt`; `score` SHALL be absent. `costDollars.total` SHALL become `costUsd`.

#### Scenario: Mapped result
- **WHEN** Exa returns a result with `highlights: ["…"]`, `publishedDate: "2026-10-19T00:00:00.000Z"` and the response has `costDollars.total: 0.004`
- **THEN** the unified result has that highlight as `snippet`, `publishedAt: "2026-10-19"`, and the response has `costUsd: 0.004`

### Requirement: Exa fetch request and freshness
A fetch SHALL send `{ urls: [url], text: { maxCharacters }, maxAgeHours, livecrawlTimeout: 15000 }` with `maxCharacters` equal to `offset + maxChars + 1` (so that a page longer than the window is detectable) and `maxAgeHours` from the provider option (default 24). When the status `source` is `crawled`, `crawledAt` SHALL be the current time; when it is `cached`, `crawledAt` SHALL be absent and `warnings` SHALL say the copy came from Exa's cache and is at most `maxAgeHours` hours old.

#### Scenario: Cached copy
- **WHEN** Exa answers with `statuses[0].source: "cached"`
- **THEN** the result has no `crawledAt` and a warning naming the cache age bound

#### Scenario: Page longer than the window
- **WHEN** `maxChars` is 20000 and Exa returns exactly 20001 characters of text
- **THEN** the result has `truncated: true`, `nextOffset: 20000` and no `totalChars`

#### Scenario: Whole page fits
- **WHEN** `maxChars` is 20000 and Exa returns 6000 characters of text
- **THEN** the result has `truncated: false` and `totalChars: 6000`

#### Scenario: Fresh crawl requested
- **WHEN** the provider option `maxAgeHours` is `0`
- **THEN** the request carries `maxAgeHours: 0` and a `crawled` status yields `crawledAt` set to the request time

### Requirement: Exa fetch response and per-URL errors
The fetch result SHALL take `content` from `results[0].text` and `title` from `results[0].title` with `extraction: "verbatim"`. A status whose `status` is `error` SHALL be a failed attempt whose reason is the status `error.tag` and `httpStatusCode` (for example `SOURCE_NOT_AVAILABLE 403`, `CRAWL_NOT_FOUND 404`, `CRAWL_LIVECRAWL_TIMEOUT 504`).

#### Scenario: Blocked source
- **WHEN** the URL is an X post and Exa returns `error.tag: "SOURCE_NOT_AVAILABLE"` with `httpStatusCode: 403`
- **THEN** the attempt's reason is `SOURCE_NOT_AVAILABLE 403` and routing continues to the next provider

#### Scenario: PDF
- **WHEN** the URL is a PDF that Exa can read
- **THEN** `content` is the extracted markdown and `extraction` is `verbatim`

### Requirement: Exa rate limiting
HTTP 429 SHALL be a failed attempt whose reason includes the `Retry-After` value when present; the provider SHALL NOT wait and retry on its own.

#### Scenario: Burst over the limit
- **WHEN** Exa answers HTTP 429 with `Retry-After: 1`
- **THEN** the attempt's reason says `429` and `retry after 1 s`, and the next provider is tried
