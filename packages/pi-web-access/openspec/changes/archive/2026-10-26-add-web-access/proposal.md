# Proposal

## Why

Pi has no built-in web access, and the third-party `pi-web-access` package the user runs today does not fit this setup: it routes searches only by a fixed provider order plus error-class fallback (no way to send X/Twitter or `.cn` sites to a particular backend), it cannot reach the Sub2API gateway's Grok and Claude search upstreams at all (its xAI client is hard-wired to `api.x.ai`, and Anthropic server tools are not supported), and its four tool declarations (about 10.8k characters) nearly exhaust the 3000-token inline budget of Pi's codemode, which the user runs in `only` mode. Meanwhile the backends available to the user (Sub2API's Codex/Claude/Grok groups and its dedicated `/v1/alpha/search` endpoint, DeepSeek's Search/Fetch API, Exa) were verified in the 2026-10-23 research to cover search *and* page fetching with hard domain filters, X post retrieval, and sub-second to few-second latencies, but each needs its own protocol and its own quirks handled.

## What Changes

- New package `packages/pi-web-access` (`@zeroclover/pi-web-access`): one extension that gives the model exactly two tools, `web_search` and `web_fetch`, and routes them over a set of pluggable providers configured in `<agent-dir>/pi-web-access.json`.
- Provider types, each a self-contained adapter that implements **both** capabilities (providers without a native fetch API fetch through their search tool's page-open ability and label the result as model-extracted):
  - `sub2api-search`: Sub2API's dedicated Codex search endpoint `/v1/alpha/search`: `search_query` for search (domain and recency filters, structured results, about 2.5 s), `open` for fetching page text verbatim with line-number paging and PDF support (from OpenAI's crawl index; pages it has not indexed fall through to the next provider).
  - `sub2api-codex`: the Codex group's native Responses `web_search` (answer plus `url_citation`s, `filters.allowed_domains`/`blocked_domains`, `user_location`).
  - `sub2api-claude`: the Claude group's native `web_search_20250305` search tool and the live-fetching `web_fetch_20260309` tool (`use_cache: false`, `allowed_callers: ["direct"]`) on `/v1/messages`.
  - `sub2api-grok`: the Grok group's native Responses `web_search` and `x_search` (handle and date filters; X post retrieval through the thread-fetch action); the only provider that can search or fetch X/Twitter.
  - `deepseek`: DeepSeek `/v1/tools/search` (query operators `site:`, `-site:`, `after:`, `lang:`, 128-character query budget, client-side host filtering because `site:` is a soft filter) and `/v1/tools/fetch` (markdown un-escaping).
  - `exa`: Exa `/search` (lite by default, hard `includeDomains`/`excludeDomains` with path prefixes and wildcard subdomains, date filters, `category`) and `/contents` (fresh crawl on request).
- Credentials are reused from Pi's own provider registry (`ctx.modelRegistry`) for every provider that is also a Pi model provider (Sub2API groups, DeepSeek); only providers with no Pi counterpart (Exa) take an API key in the file, written as a literal, `$ENV`, or `!command`. The extension never reads another extension's private files.
- Routing: an ordered default provider chain per capability with fallback to the next provider on failure; named site rules (several hostname patterns each, e.g. `CN: [".cn"]`, `X: ["x.com", "twitter.com"]`) that pick the provider chain when a search is restricted to, or a fetch targets, a matching site; and a per-call `provider` override the model passes when the user asks for a specific backend, which bypasses rules and priority.
- Provider-specific behavior is honoured through the unified parameters (domains, exclusions, recency, result count, content) mapped per adapter, through per-provider options in the configuration file (for example Exa's search type, Codex's `user_location`), and through result post-processing the adapters cannot do themselves (host filtering for soft filters, URL normalisation and deduplication, snippet and content truncation with a continuation hint).
- Tool results are data: both tools declare `outputSchema` and return `structuredContent` so codemode scripts receive typed results, and their declarations stay small enough for the codemode inline budget.
- A `/web-access` command prints the effective configuration: providers with their credential status, the default chains, and the site rules, without revealing secrets.
- Out of scope for this change (candidates for later changes): a LiteLLM search-API provider, key-less fallbacks (Jina Reader, Tavily keyless), a local HTTP + Readability fetcher, Sub2API's Grok-group dedicated endpoints `/v1/web_search` and `/v1/x_search` (45 s with no filters, and 502 respectively, as of 2026-10-23), result caching, parallel multi-provider fan-out, and any browser UI.

## Capabilities

### New Capabilities
- `web-search`: the `web_search` tool: its parameters, the unified result schema (answer, results with title/url/snippet/content/publishedAt, provider, warnings, cost and latency), client-side domain filtering and deduplication, output truncation, and the size of its declaration.
- `web-fetch`: the `web_fetch` tool: URL fetching into markdown/plain text with offset-based continuation, the `verbatim` versus `model` extraction label, failure reporting per URL, and the size of its declaration.
- `provider-routing`: default provider chains, fallback classification, site rules and their pattern syntax, the per-call provider override, and how the chosen provider and any fallbacks are reported in results.
- `sub2api-providers`: the four Sub2API provider types: endpoints, request mapping of the unified parameters, response normalisation (citations, sources, tool-result blocks, alpha `results`/`output`), fetch emulation on Responses, X handle mapping, and failure detection (including alpha's `Internal Error ()` text).
- `deepseek-provider`: the DeepSeek Search and Fetch adapter: operator composition within the 128-character limit, host post-filtering, score threshold, markdown un-escaping, and error mapping.
- `exa-provider`: the Exa adapter: `/search` and `/contents` mapping, search type selection, freshness control, status handling per URL, and cost reporting.
- `web-access-configuration`: the `pi-web-access.json` file: provider instances and their types, credential sources (Pi provider or key expression), routing sections, validation with per-field fallback and warnings, and the `/web-access` inspection command.

### Modified Capabilities
<!-- none: this is the package's first change -->

## Impact

- New files only: `packages/pi-web-access/{package.json,README.md,src/*,test/*}` and a row in the root `README.md`. No change to other packages or shared tooling.
- Pi APIs used: `defineTool`/`pi.registerTool` (with `outputSchema`, `annotations`, `promptSnippet`), `pi.registerCommand`, `pi.on("session_start")`, `ctx.modelRegistry.getAll()/find()/getApiKeyAndHeaders()/getApiKeyForProvider()`, `getAgentDir()`, `ctx.ui.notify`, `ctx.signal`/the tool `signal`; `StringEnum` from `@earendil-works/pi-ai`; `typebox` schemas. Provider HTTP calls go through the global `fetch` with hand-parsed SSE where a backend streams; no runtime dependencies.
- Peer dependencies: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`.
- Prerequisites recorded in `tasks.md`: the Pi host pin moves from 1.3.0 to the current latest (1.4.0) in its own pull request first (`docs/workflow.md`, "Track the latest Pi"); users uninstall the third-party `pi-web-access` package before enabling this one, because Pi refuses to start when two extensions register the same tool name (`web_search`).
- Known interaction, accepted with the tool names: when the main conversation model is a Sub2API Grok model, the gateway counts every call of a client tool named `web_search` as a native search in its own accounting (about $0.005 per call) and, on Grok accounts it recognises as free, replaces such tools with native search; the README documents this and the fix belongs in Sub2API's counting logic.
- External services: the user's Sub2API instance (Codex, Claude, Grok groups), DeepSeek's API, Exa's API. Tests replace all of them with local HTTP fixtures; live checks against the real services are a manual verification step.
