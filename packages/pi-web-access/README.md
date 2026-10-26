# pi-web-access

Web search and page fetching for Pi through the backends you already have: the Codex, Claude and Grok groups of a [Sub2API](https://github.com/Wei-Shaw/sub2api) gateway, DeepSeek's Search and Fetch API, and Exa. The model gets two small tools, `web_search` and `web_fetch`; which backend answers is decided by your configuration: an ordered chain with fallback, site rules that send, say, X/Twitter to Grok and `.cn` sites to DeepSeek, and a per-call override for when you ask for a specific provider. Credentials come from Pi's own providers wherever a backend is also a Pi model provider, so no key is configured twice.

## Install

Releases are published to npm as `@zeroclover/pi-web-access`; each release is tagged `@zeroclover/pi-web-access@<version>`.

```bash
pi install npm:@zeroclover/pi-web-access          # install a published version
pi -e ./packages/pi-web-access                    # try a repository checkout for one session
pi install /absolute/path/to/packages/pi-web-access  # install a repository checkout for the user
```

**Remove the third-party `pi-web-access` package first** (`npm:pi-web-access` in Pi's `packages`). It registers a tool named `web_search` as well, and Pi refuses to start when two extensions register the same tool name.

Requires Pi's latest stable release; older releases are not supported.

## Provides

| Kind | Name | Description |
|---|---|---|
| tool | `web_search` | Searches the web and returns results with title, URL and snippet, plus the backend's answer when it writes one. |
| tool | `web_fetch` | Returns the text of one page as markdown or plain text, in windows that continue by offset. |
| command | `/web-access` | Shows the configuration file path, every provider with its type, capabilities and credential status, the `search` and `fetch` chains, and the site rules. Never prints a key. |

Both tools are registered whether or not the file exists; without a usable provider a call fails with a message naming the configuration file. Both are read-only and declare `outputSchema`, so codemode scripts receive the structured result described below instead of text.

### `web_search`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | required | The search query. `site:<host>` and `site:<host>/<path>` tokens move into `domains`, `-site:<host>` into `excludeDomains`. |
| `domains` | string[] | none | Only these sites: a host (`github.com`, subdomains included), a host with a path prefix (`go.dev/doc`, `x.com/golang` for one account), or a suffix (`.cn`). |
| `excludeDomains` | string[] | none | Sites to leave out, same syntax. |
| `recency` | `day` \| `week` \| `month` \| `year` | none | Only pages from that period (1, 7, 30 or 365 days back). |
| `maxResults` | integer 1–20 | 5 | Number of results. |
| `includeContent` | boolean | false | Also return page text excerpts, where the backend has them. |
| `provider` | string | none | A configured provider name; only that provider is tried. |

The result (`structuredContent`; the model sees the same data as markdown):

| Field | Meaning |
|---|---|
| `provider` | The configured provider whose results are returned. |
| `query` | The model's query without its `site:` operators; a backend may receive it with its own operators added (DeepSeek). |
| `answer` | The backend's written answer, for backends that produce one (`sub2api-codex`, `sub2api-claude`, `sub2api-grok`). |
| `results[]` | `{ title, url, snippet, content?, publishedAt?, score? }`; `publishedAt` is a `YYYY-MM-DD` date, `score` the backend's relevance score (DeepSeek). |
| `attempts[]` | Every provider considered, in order: `{ provider, outcome, reason?, latencyMs? }` with `outcome` `ok`, `empty`, `error` or `skipped`. |
| `warnings[]` | Options a provider ignored, filters applied client-side, truncation, emulation notices. |
| `costUsd` | The cost the backend reported (Exa, Grok). |
| `latencyMs` | Duration of the whole call. |

Whatever the backend does with domain filters, results outside `domains` or inside `excludeDomains` are removed, and `warnings` counts them. URLs are normalised (lower-case host, no fragment, no `utm_*`, `fbclid`, `gclid`) and duplicates removed. Snippets are cut at 500 characters and content at 4000, with a `[…]` marker and a warning pointing to `web_fetch`.

### `web_fetch`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | An `http` or `https` URL. |
| `offset` | integer ≥ 0 | 0 | Character position in the page text to start from. |
| `maxChars` | integer 1000–100000 | 20000 | Characters to return. |
| `provider` | string | none | A configured provider name; only that provider is tried. |

The result:

| Field | Meaning |
|---|---|
| `provider`, `url` | Who answered, and the requested URL. |
| `finalUrl`, `title` | When the backend reports them. |
| `content` | The text from `offset`, at most `maxChars` characters. |
| `extraction` | `verbatim` when the text is the page's own, `model` when a language model read the page and wrote it out (then `warnings` says so). |
| `truncated`, `nextOffset` | Whether the text continues, and the `offset` for the next call. For `extraction: model` this concerns the rendition, not the page. |
| `totalChars` | The page length, when the whole page is known. |
| `crawledAt` | When the copy was crawled: a date-time or the backend's relative age (`3 weeks ago`). Absent when unknown. |
| `attempts`, `warnings`, `costUsd`, `latencyMs` | As for `web_search`. |

An attempt that returns no text, or a failure page with HTTP 200, counts as failed, and the next provider is tried.

## How a call is routed

1. With `provider`, only that provider is tried, and its failure is the call's failure.
2. Otherwise the first rule whose sites match picks the chain: for a search, a rule matches when one of its sites matches an entry of `domains`; for a fetch, when one matches the URL. A rule without a chain for that capability leaves the default in force. A search without `domains` matches no rule.
3. Otherwise the default chain: `search` or `fetch` from the file, or every provider in declaration order.

The chain is tried in order. A provider is passed over (`skipped`) when it has no usable credentials or cannot serve the request (`sub2api-claude` and PDFs); an attempt fails (`error`) on a transport error, its `timeoutMs`, an HTTP error, or a failure the backend reports in its body. A domain-restricted search whose filtered results are empty is recorded as `empty` and the next provider is tried, because several backends return nothing for sites they do not index; if all are empty, the call returns no results with the full trace. While the chain runs, progress (`exa failed (…); trying ds`) is shown as a tool update. Escape cancels the request in flight, and no further provider is contacted.

## Configuration

The file is `<agent-dir>/pi-web-access.json` (normally `~/.pi/agent/pi-web-access.json`), read when a session starts. **Changes take effect after `/reload` or in a new session.** Each problem in the file is reported once as a warning at session start, and only the affected part is dropped or defaulted.

```jsonc
{
  "providers": {
    "<name>": { "type": "<provider type>", /* common keys and type options */ }
  },
  "search": ["<name>", "..."],   // default search chain; every provider in order when omitted
  "fetch": ["<name>", "..."],    // default fetch chain; every provider in order when omitted
  "rules": [
    { "name": "X", "sites": ["x.com", "twitter.com"], "search": ["grok"], "fetch": ["grok"] }
  ]
}
```

Provider names are non-empty and contain no whitespace. Names in chains and rules that do not refer to a configured provider are removed; a rule without a `name`, without `sites`, or left with no provider is dropped.

### Common provider keys

| Key | Meaning |
|---|---|
| `type` | One of the types below. Required. |
| `provider` | The Pi provider whose key, extra headers and base URL are reused (what `/login` or `models.json` defines). Required for the `sub2api-*` types; `deepseek` defaults to `deepseek`. |
| `model` | The model id sent to the gateway. Required for the `sub2api-*` types. |
| `apiKey` | A key expression (below). When present it is used instead of the Pi provider's key. `exa` defaults to `$EXA_API_KEY`. |
| `baseUrl` | Overrides the endpoint base. |
| `timeoutMs` | Integer 1000–600000; default 180000 for `sub2api-grok`, 60000 for every other type. |

**Key expressions** follow Pi's `models.json` syntax: a literal; `$NAME` or `${NAME}` for an environment variable; `!command` for the trimmed output of a shell command (run once per session, on first use, so `!op read "op://Vault/Item/credential"` prompts once per session, again only after a timeout; it may take as long as the provider's `timeoutMs`, which leaves time to approve a password-manager prompt, and a command that timed out is run again on the next call); `$$` for a literal `$` and `$!` for a literal leading `!`. The extension never reads other extensions' files for credentials and never writes a key anywhere.

**Site patterns** (rule `sites`, `domains`, `excludeDomains`) are matched against the URL host, lower-cased and without port: `.cn` matches hosts ending in `.cn`; `github.com` matches that host and its subdomains (not `codedtx.com` for `x.com`); `github.com/golang` also requires the path to start with `/golang` on a segment boundary (`/golang/go`, not `/golang-migrate`). Paths are case-sensitive. `twitter.com` and `x.com` name the same site, and an entry naming one X post (`x.com/<user>/status/<id>`) also matches its handle-less forms `x.com/i/status/<id>` and `x.com/i/web/status/<id>`, in rules and filters alike (a photo or subpage of a post is matched by its path only). Backends that can only exclude whole hosts receive only the exclusions without a path; an exclusion such as `go.dev/doc/install` is applied to the results instead.

### Provider types

| Type | Search | Fetch | Options (default) |
|---|---|---|---|
| `sub2api-search` | The Codex group's `/v1/alpha/search`: structured results, host filters at the provider (path filters on the results), recency, about 2.5 s. | `open` on the same endpoint: the page text verbatim, paged by lines, PDFs with page headings, crawl age as `crawledAt`. | `userLocation` (none) |
| `sub2api-codex` | The Codex group's Responses `web_search`: an answer with cited pages, domain and exclusion filters, no date filter. | The model opens the page in `web_search` and writes it out (`extraction: model`). | `userLocation` (none), `searchContextSize`: `low`, `medium`, `high` (backend default) |
| `sub2api-claude` | The Claude group's `web_search_20250305` on `/v1/messages`: an answer and the result list with cited passages; allowed or blocked domains (when `domains` is given, exclusions are applied to the results). | `web_fetch_20260309`, live (`use_cache: false`): the page text verbatim. Skips `.pdf` URLs and fails documents that come back as PDF. | `maxUses` 1–10 (3), `userLocation` (none) |
| `sub2api-grok` | The Grok group's Responses `x_search` when every domain is an X host (`x.com/<handle>` selects accounts, `recency` sets `from_date`), `web_search` otherwise. The only provider that can search X. X cites posts as `x.com/i/status/<id>`; when the `x_search` was restricted to exactly one account the citation gets that account's URL, otherwise a handle filter cannot recognise it and drops it. | X post URLs through `x_search`; other pages opened in `web_search` (`extraction: model`). The only provider that can fetch X posts. | `enableImageUnderstanding` (false) |
| `deepseek` | `POST /tools/search` with `site:`, `-site:` and `after:` operators in the query (128-character limit; filters that do not fit are applied to the results). `site:` is a preference, so three times as many results are requested. | `POST /tools/fetch`: page markdown with DeepSeek's backslash escapes removed. | none |
| `exa` | `POST /search`, `lite` by default, hard domain filters with path prefixes, `recency` as a start date (which drops undated pages; a warning says so). | `POST /contents`, verbatim, PDFs included (Exa may put its own metadata, such as citation counts, before a paper's text); at most `maxAgeHours` old. | `searchType`: `lite`, `auto` (`lite`); `category`: `company`, `publication`, `news`, `personal site`, `financial report`, `people` (none); `maxAgeHours` 0–8760 (24; 0 forces a fresh crawl) |

`userLocation` is `{ "country": "US", "region": "…", "city": "…", "timezone": "…" }`, all optional.

Endpoints: the `sub2api-*` types use the base URL of the Pi provider's models (`<base>/alpha/search`, `<base>/responses`; the Claude group's `<root>/v1/messages`). `deepseek` defaults to `https://api.deepseek.com/v1`, `exa` to `https://api.exa.ai`.

### Example

The Pi providers named here (`gateway-codex`, `gateway-claude`, `xai`) are whatever your Sub2API groups are called in Pi; `xai` stands for Pi's built-in xAI provider pointed at the gateway's Grok group in `models.json`.

```json
{
	"providers": {
		"codex-search": { "type": "sub2api-search", "provider": "gateway-codex", "model": "gpt-6-luna" },
		"codex": { "type": "sub2api-codex", "provider": "gateway-codex", "model": "gpt-6-luna" },
		"claude": { "type": "sub2api-claude", "provider": "gateway-claude", "model": "claude-sonnet-5-5" },
		"grok": { "type": "sub2api-grok", "provider": "xai", "model": "grok-4.6" },
		"deepseek": { "type": "deepseek" },
		"exa": { "type": "exa", "apiKey": "!op read \"op://Private/Exa/credential\"", "maxAgeHours": 24 }
	},
	"search": ["codex-search", "deepseek", "exa", "claude"],
	"fetch": ["codex-search", "exa", "claude", "deepseek"],
	"rules": [
		{ "name": "X", "sites": ["x.com", "twitter.com"], "search": ["grok"], "fetch": ["grok"] },
		{ "name": "CN", "sites": [".cn", "zhihu.com"], "search": ["deepseek", "codex-search"], "fetch": ["deepseek", "codex-search"] }
	]
}
```

Run `/web-access` afterwards: every provider should show `ready` (or `not resolved yet` for a `!command` key that has not been needed yet).

## Things to know

- **The Grok group counts a client tool named `web_search` as a search.** When your conversation model itself is a Sub2API Grok model, the gateway counts every call of a client tool named `web_search` as one of its native searches in its own accounting (about $0.005 per call), and on Grok accounts it treats as free it may replace such tools with native search. This is the gateway's name-based logic; the fix belongs in Sub2API.
- **`sub2api-search` fetches from OpenAI's crawl index**, not live. Pages it has not indexed fail as `not indexed` and the next provider is tried; `crawledAt` carries the age the index reports. `http://` URLs are upgraded to `https://`, so a site without HTTPS fails there.
- **Exa and DeepSeek return nothing for reddit and X**, and DeepSeek's `site:` is only a preference. Send those sites elsewhere with a rule (the example sends X to Grok); domain-restricted searches that come back empty fall through the chain on their own.
- **Model-mediated text** (`extraction: model`, from `sub2api-codex` and `sub2api-grok`) is slow (often 40 s or more on Grok) and a model's rendition of the page; keep those providers out of the default `fetch` chain and reach them through rules or `provider`. A model may also decline to reproduce a page; its reply then comes back as the content, so read model-extracted text with that in mind.
- **Grok cost** (`costUsd`) is derived from the gateway's `usage.cost_in_usd_ticks` as ticks × 1e-10 USD; the unit is inferred from observed values, not documented.
- **Configuration edits need `/reload`** or a new session.
