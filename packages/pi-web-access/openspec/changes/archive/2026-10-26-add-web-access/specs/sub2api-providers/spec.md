# Spec Delta

## Purpose

The four Sub2API provider types (`sub2api-search`, `sub2api-codex`, `sub2api-claude`, `sub2api-grok`): which gateway endpoint and protocol each uses, how the unified parameters map onto it, how its responses become unified results, and how its failures are recognised.

## ADDED Requirements

### Requirement: Sub2API credentials and endpoints come from Pi's provider
A Sub2API provider entry SHALL name a Pi provider (`provider`) and a model id (`model`). Requests SHALL use the API key and extra headers Pi resolves for that provider, and the endpoint SHALL be derived from the base URL of that provider's models (or `baseUrl` when configured): `<base>/alpha/search` and `<base>/responses` for the Codex and Grok groups, `<root>/v1/messages` for the Claude group.

#### Scenario: Codex group registered by the Sub2API provider extension
- **WHEN** `provider` is a Pi provider whose models have base URL `https://gateway.example/v1`
- **THEN** `sub2api-search` posts to `https://gateway.example/v1/alpha/search` and `sub2api-codex` to `https://gateway.example/v1/responses`, both with that provider's key and extra headers

#### Scenario: Pi provider missing
- **WHEN** `provider` names a Pi provider with no registered models
- **THEN** the provider is skipped with the reason that the Pi provider was not found

### Requirement: `sub2api-search` searches through the alpha endpoint
A `sub2api-search` search SHALL post a Codex standalone search request with header `Originator: codex_cli_rs`, a fresh `id`, `model`, one `commands.search_query` entry `{ q, recency?, domains? }` (`recency` 1, 7, 30 or 365 days; `domains` the hostnames of `domains`), `commands.response_length: "short"`, `settings.filters.blocked_domains` from the entries of `excludeDomains` without a path, and `settings.user_location` from the provider option.

#### Scenario: Filtered search
- **WHEN** the model searches `latest stable Go release` with `domains: ["go.dev"]`, `excludeDomains: ["golang.google.cn"]` and `recency: "month"`
- **THEN** the request carries `search_query: [{ "q": "latest stable Go release", "recency": 30, "domains": ["go.dev"] }]`, `response_length: "short"` and `settings.filters.blocked_domains: ["golang.google.cn"]`

### Requirement: Alpha search results
Results SHALL come from `results[]` entries of type `text_result` (`title`, `url`, `snippet`); the `output` text SHALL NOT be used as an answer. An `output` starting with `Empty search results` SHALL yield zero results, and an HTTP 400 with an `error.code` SHALL be a failed attempt naming that code.

#### Scenario: Mapped results
- **WHEN** the endpoint returns three `text_result` entries
- **THEN** `results` has three entries with their `title`, `url` and `snippet`, and `answer` is absent

#### Scenario: No results
- **WHEN** `output` starts with `Empty search results` and `results` is empty
- **THEN** the attempt yields zero results without an error

#### Scenario: Parameter rejected
- **WHEN** the endpoint answers HTTP 400 with an `error.code` such as `unknown_parameter`
- **THEN** the attempt fails with a reason that includes `400` and that code

### Requirement: `sub2api-search` fetches through the alpha `open` command
A `sub2api-search` fetch SHALL send `commands.open: [{ ref_id: <url>, lineno? }]` with `response_length: "long"`, rebuild the page text from the `L<n>:` lines (prefixes removed, link markup reduced to its text, PDF page markers `@P<n>` kept as headings), and take `title` and `finalUrl` from the header line and `crawledAt` from the `Crawled:` note. The result SHALL be `extraction: "verbatim"`.

#### Scenario: Single-window page
- **WHEN** the endpoint returns a page whose `Total lines` fit in one window, with header `Crawled: today`
- **THEN** `content` is the joined line text without `L<n>:` prefixes, `crawledAt` is `today`, and `extraction` is `verbatim`

### Requirement: Alpha fetch pagination
When a window does not reach the last line (`Total lines` minus one), the fetch SHALL request the next window with `lineno` set to the highest line seen plus one and drop lines already seen, until the last line is reached or `offset + maxChars` characters are covered.

#### Scenario: Multi-window page
- **WHEN** the page has 644 lines and each window returns about 200 lines with an overlapping backfill
- **THEN** successive requests carry `lineno` equal to the previous window's highest line plus one, overlapping lines appear once, and no line is missing

#### Scenario: PDF
- **WHEN** the lines are prefixed `L<n>@P<page>:`
- **THEN** the content keeps page boundaries as headings and `extraction` is `verbatim`

#### Scenario: Fetch failure inside a 200 response
- **WHEN** `output` starts with `Internal Error ()` and a line `Failed to fetch <url>: (403) Forbidden`
- **THEN** the attempt is recorded as an error with reason `403 Forbidden` and routing continues

#### Scenario: Page not in the index
- **WHEN** the `L0:` line says the URL `is not accessible via this tool`
- **THEN** the attempt is recorded as an error with reason `not indexed` and routing continues

### Requirement: `sub2api-codex` searches with the Responses `web_search` tool
A `sub2api-codex` search SHALL post a streaming Responses request with `tools: [{ type: "web_search", filters: { allowed_domains?, blocked_domains? }, user_location?, search_context_size? }]`, `tool_choice: "required"`, `include: ["web_search_call.action.sources"]` and `store: false`, where the filters hold the hostnames of `domains` and of the path-less entries of `excludeDomains`, and `user_location` and `search_context_size` come from the provider's options.

#### Scenario: Filtered request
- **WHEN** the model searches with `domains: ["github.com"]` and `excludeDomains: ["reddit.com"]`
- **THEN** the request's tool carries `filters: { "allowed_domains": ["github.com"], "blocked_domains": ["reddit.com"] }` and `tool_choice` is `required`

### Requirement: Responses search results come from citations and sources
For `sub2api-codex` and `sub2api-grok` web searches, `answer` SHALL be the output text and results SHALL come from `url_citation` annotations (title, url, the cited passage as snippet) followed by `web_search_call` sources that were not cited (url, host as title). A response without any `web_search_call` SHALL be a failed attempt.

#### Scenario: Citations and sources
- **WHEN** the response contains one `web_search_call` with three sources and a message with two `url_citation` annotations
- **THEN** `results` lists the two cited pages first, then the remaining source URL with its host as title, and `answer` is the message text

#### Scenario: Model answered without searching
- **WHEN** the response contains a message but no `web_search_call`
- **THEN** the attempt fails with reason `no web search performed`

### Requirement: `sub2api-codex` fetches by opening the page inside `web_search`
A `sub2api-codex` fetch SHALL post a Responses `web_search` request instructing the model to open the given URL and return its text verbatim, SHALL accept the attempt only when a `web_search_call` action opened that URL, and SHALL return the message text with `extraction: "model"`.

#### Scenario: Page opened by the model
- **WHEN** the response has a `web_search_call` whose action type is `open_page` for the requested URL and a message
- **THEN** the result's `content` is the message text, `extraction` is `model` and `warnings` carries the rendition warning

### Requirement: `sub2api-claude` searches with `web_search_20250305`
A `sub2api-claude` search SHALL post to `/v1/messages` with `tools: [{ type: "web_search_20250305", name: "web_search", max_uses, allowed_domains? | blocked_domains?, user_location? }]` (hostnames only; `max_uses` default 3). When both `domains` (hosts or suffixes) and `excludeDomains` are given, no `blocked_domains` SHALL be sent, the exclusions SHALL be enforced client-side, and `warnings` SHALL say so.

#### Scenario: Domain-restricted search
- **WHEN** the model searches with `domains: ["github.com"]`
- **THEN** the request's tool carries `allowed_domains: ["github.com"]` and `max_uses: 3`

#### Scenario: Both filters requested
- **WHEN** the model searches with `domains: ["github.com"]` and `excludeDomains: ["gist.github.com"]`
- **THEN** the request carries only `allowed_domains`, `gist.github.com` results are removed client-side, and `warnings` mentions it

### Requirement: Anthropic search results come from tool-result blocks
For `sub2api-claude`, `answer` SHALL be the concatenated text blocks; results SHALL come from `web_search_tool_result` entries (`url`, `title`), with the `cited_text` of citations that reference the same URL as snippet. Zero `usage.server_tool_use.web_search_requests`, or a tool result whose `content` is an error object, SHALL be a failed attempt whose reason includes the `error_code`.

#### Scenario: Results with citations
- **WHEN** the response holds ten `web_search_result` entries and text blocks citing two of them
- **THEN** `results` has ten entries, two of which carry the cited passages as snippets, and `answer` is the text

#### Scenario: Search tool error
- **WHEN** the `web_search_tool_result` content is `{ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }`
- **THEN** the attempt fails with a reason containing `max_uses_exceeded`

#### Scenario: Gateway emulated the search
- **WHEN** the tool-use id starts with `srvtoolu_ws_`
- **THEN** `warnings` says the gateway emulated the search and provider-side filters were not applied

### Requirement: `sub2api-claude` fetches live with `web_fetch_20260309`
A `sub2api-claude` fetch SHALL post to `/v1/messages` with `tools: [{ type: "web_fetch_20260309", name: "web_fetch", max_uses: 1, allowed_callers: ["direct"], use_cache: false, allowed_domains: [<url host>], max_content_tokens }]`, with `max_content_tokens` three times `offset + maxChars`.

#### Scenario: Fetch request
- **WHEN** the model fetches `https://go.dev/doc/devel/release` with `maxChars: 20000`
- **THEN** the request's tool has `allowed_domains: ["go.dev"]`, `use_cache: false`, `allowed_callers: ["direct"]` and a `max_content_tokens` of 60000

### Requirement: `sub2api-claude` fetch completeness
Because the fetch tool cuts a document at `max_content_tokens` without saying so, and a token is at least one byte while a character is at most three, a fetched text SHALL count as the whole page only when it is shorter than `offset + maxChars` characters.

#### Scenario: Document that may have been cut
- **WHEN** a fetch with `maxChars: 1000` returns a document of 1000 characters or more
- **THEN** the result has `truncated: true`, `nextOffset: 1000` and no `totalChars`

### Requirement: Anthropic fetch results
`content` SHALL come from the `web_fetch_tool_result` text document, `title` from the document and `crawledAt` from `retrieved_at`, with `extraction: "verbatim"`. Zero `usage.server_tool_use.web_fetch_requests` or an error block SHALL be a failed attempt whose reason includes the `error_code`.

#### Scenario: Successful fetch
- **WHEN** the response holds a `web_fetch_tool_result` with a text document and `retrieved_at`
- **THEN** `content` is that document's text, `crawledAt` is `retrieved_at` and `extraction` is `verbatim`

#### Scenario: URL the tool refuses
- **WHEN** the tool result is an error with `error_code: "url_not_allowed"`
- **THEN** the attempt fails with a reason containing `url_not_allowed` and routing continues

### Requirement: `sub2api-claude` does not fetch PDFs
Because the Anthropic fetch tool returns PDFs as the whole file in base64, a `sub2api-claude` fetch SHALL be skipped with reason `unsupported: pdf` when the URL path ends in `.pdf`, and a response whose document `media_type` is `application/pdf` SHALL be a failed attempt with the same reason.

#### Scenario: PDF URL
- **WHEN** the model fetches `https://arxiv.org/pdf/1706.03762.pdf` through a chain starting with a `sub2api-claude` provider
- **THEN** that provider is skipped without a request and the next provider is tried

### Requirement: `sub2api-grok` routes X searches to `x_search` and others to `web_search`
A `sub2api-grok` search whose `domains` are all X hosts (`x.com`, `twitter.com`, with optional `/<handle>` paths) SHALL use `tools: [{ type: "x_search", allowed_x_handles?, excluded_x_handles?, from_date?, to_date? }]` without any `include`; every other search SHALL use `web_search` with `filters.allowed_domains`/`excluded_domains` and `include: ["web_search_call.action.sources"]`. Results SHALL come from `url_citation` annotations, replacing numeric or URL titles with the host or post id.

#### Scenario: Posts of one account
- **WHEN** the model searches with `domains: ["x.com/golang"]` and `recency: "month"`
- **THEN** the request's tool is `x_search` with `allowed_x_handles: ["golang"]` and `from_date` one month back, and no `include` field

#### Scenario: Ordinary web search on Grok
- **WHEN** the model searches with `domains: ["github.com"]`
- **THEN** the request's tool is `web_search` with `filters.allowed_domains: ["github.com"]`

#### Scenario: Mixed X and web hosts
- **WHEN** the model searches with `domains: ["x.com/golang", "go.dev"]`
- **THEN** the request's tool is `web_search` with `filters.allowed_domains: ["x.com", "go.dev"]` and `warnings` says X hosts were searched through web search rather than `x_search`

#### Scenario: Numeric citation titles
- **WHEN** a `url_citation` has title `1` and url `https://x.com/i/status/2103386967853367366`
- **THEN** the result's title is `x.com post 2103386967853367366`

### Requirement: Handle-less X citations are attributed only when the author is known
X cites posts as `x.com/i/status/<id>`, without the author. When the `x_search` was restricted to exactly one account, such a citation SHALL get that account's URL `https://x.com/<handle>/status/<id>`; otherwise it SHALL stay as cited, and the client-side filter treats it as outside any `x.com/<handle>` entry.

#### Scenario: Handle-less citation on a one-account search
- **WHEN** the model searches with `domains: ["x.com/golang"]` and a `url_citation` has url `https://x.com/i/status/2112389486977933621`
- **THEN** the result's url is `https://x.com/golang/status/2112389486977933621` and it passes the `x.com/golang` filter

#### Scenario: Handle-less citation with an unknown author
- **WHEN** the model searches with `domains: ["x.com/golang", "x.com/rob_pike"]` and a `url_citation` has url `https://x.com/i/status/1`
- **THEN** that result is removed by the client-side filter

### Requirement: Grok exclusions
When `domains` and `excludeDomains` are both given to Grok's `web_search`, no `excluded_domains` SHALL be sent and `warnings` SHALL say that the exclusions were applied to the results. Only an exclusion of a whole account (`x.com/<handle>`) SHALL become an `excluded_x_handles` entry of `x_search`; a post or subpage SHALL be excluded on the results alone.

#### Scenario: Excluding one post
- **WHEN** the model searches with `domains: ["x.com"]` and `excludeDomains: ["x.com/golang/status/1"]`
- **THEN** the `x_search` tool carries no `excluded_x_handles`, and only that post is removed from `results`

### Requirement: `sub2api-grok` fetches X posts through `x_search` and other pages through `web_search`
A `sub2api-grok` fetch of an X post URL (`x.com/<user>/status/<id>` or the `twitter.com` form) SHALL use `x_search` asking for that post (with `enable_image_understanding` from the provider option, default off) and return the post text with author handle and date; any other URL SHALL be opened through `web_search` as `sub2api-codex` does. Both SHALL be `extraction: "model"`, and inline citation markers (`render_inline_citation` …) SHALL be removed from the text.

#### Scenario: X post
- **WHEN** the model fetches `https://x.com/GoLandIDE/status/2103386967853367366`
- **THEN** the request uses `x_search`, and `content` holds the post text, `@GoLandIDE` and the post date, with `extraction: "model"` and no citation markers

#### Scenario: Post does not exist
- **WHEN** `usage.num_server_side_tools_used` is 0 and the response has no `url_citation` (with or without an `x_thread_fetch` call)
- **THEN** the attempt fails with reason `post not found`

### Requirement: Grok cost is derived from usage ticks
When a Grok response carries `usage.cost_in_usd_ticks`, `costUsd` SHALL be that value × 1e-10.

#### Scenario: Cost present
- **WHEN** `usage.cost_in_usd_ticks` is `416865600`
- **THEN** `costUsd` is `0.04168656`

### Requirement: Responses failures are recognised
For `sub2api-codex` and `sub2api-grok`, an HTTP status of 400 or more, an `error` or `response.failed` stream event, a stream that ends without `response.completed`, or a completed response whose `status` is not `completed` SHALL be a failed attempt whose reason includes the status or the event's message.

#### Scenario: Upstream rejects the request
- **WHEN** the gateway answers HTTP 400 with `Upstream rejected the request`
- **THEN** the attempt's reason is `400 Upstream rejected the request` and routing continues
