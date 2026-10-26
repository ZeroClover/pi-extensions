# Design

## Context

See proposal.md "Why" for motivation. The facts below were established on 2026-10-23 by reading Pi 1.3.0 (`node_modules/@earendil-works/pi-coding-agent`), the Sub2API source (`dba770d56`), the Codex CLI source (`ce0323f2f2`), the DeepSeek and Exa documentation, and by live requests against the user's Sub2API instance, DeepSeek and Exa. They are what the decisions rest on.

**Pi host**

- The facts below were verified on Pi 1.3.0; the host upgrade to 1.4.0 (pull request #21, `chore(repo): upgrade Pi host to 1.4.0`) precedes this package. A diff of the two releases shows no change to `core/extensions/types.d.ts`, `core/model-registry.d.ts`, the extension runner, the codemode tool, or `dist/index.d.ts`; 1.4.0 fixes the activation of a newly installed extension's tools when an older session is resumed (#11062).
- Two extensions registering the same tool name make the Pi CLI exit with `Tool "web_search" conflicts with …` (the SDK path records the error and keeps the first registration). The third-party `pi-web-access` package registers `web_search`, so it cannot be installed alongside this one.
- Credentials: `ctx.modelRegistry.getAll()` / `find(provider, id)` return models with `baseUrl` but never their configured `headers`; `getApiKeyAndHeaders(model)` returns `{ ok: true, apiKey, headers?, baseUrl? }` where `headers` includes model-level headers (the Sub2API provider extension's codex models carry `Authorization: Bearer <key>` there) and `baseUrl` is present only for providers registered as native pi-ai `Provider` objects (absent, not empty, for static providers). `getProviderAuth()` throws when an environment variable is unset; `getApiKeyForProvider()` returns `undefined`. All of these work inside a tool's `execute` through `ctx.modelRegistry`. Pi's own `resolveConfigValue` (literal / `$NAME` / `${NAME}` / `!command` / `$$` / `$!`) is not exported.
- Codemode in `only` mode hides every tool from the model and lists each active tool's declaration (parameters with their descriptions as comments, and the result type from `outputSchema`) inside the codemode tool description, within an inline budget of about 3000 tokens. Scripts receive `structuredContent` as objects. `content` remains required on every result. When a model sends a JSON string for an array parameter, Pi wraps the string into a one-element array without an error; Pi's own `edit` tool uses `prepareArguments` to parse such strings.
- A tool's `signal` aborts within about 100 ms of `session.abort()` (the Escape path); an in-flight `fetch` is cancelled and the tool result becomes an aborted error.
- `before_provider_headers` can add headers to the session's own model requests (`ctx.model` identifies the provider); `before_provider_request` sees only the payload. Neither affects requests the extension makes itself.
- The e2e harness (`tools/e2e/src/`): `startPi({ agentFiles: { "models.json", "auth.json" } })` registers providers whose credentials the registry resolves; a `node:http` server on `127.0.0.1` is reachable from tool code (`PI_OFFLINE` does not block it); `pi.toolResults()` yields result text, `pi.session.subscribe()` exposes `tool_execution_update` and `tool_execution_end` (the latter carries `structuredContent`), `pi.ui.notices` the notifications, `pi.entries()` the session entries, and `pi.provider.requests[].tools` the declarations the model received; codemode is enabled in a test by loading a one-line extension file that exports `createCodemodeExtension({ mode: "only" })` and passing `tools: ["codemode", …]`.

**Sub2API gateway** (groups route by API key; each group speaks one native protocol)

- Cross-protocol entries (Chat Completions into any group, Responses into Claude, Messages into Grok) rewrite server tools to parameterless forms and drop citations; `web_search_options` and `web_search_preview` do not work anywhere. The Codex group forbids `/v1/messages`.
- `/v1/alpha/search` (Codex group): header `Originator: codex_cli_rs`; `search_query[].domains` is a hard include filter and `settings.filters.blocked_domains` a hard exclude; `allowed_domains` is an outer boundary that interacts with `domains`, so it is not used; `search_context_size` has no effect; `max_output_tokens` silently truncates `results[]` (never set); `commands.response_length` changes only the `output` text (short ≈ 12k, medium ≈ 17k, long ≈ 25k characters per `open` window) and leaves `results[]` identical. Several queries in one request interleave their results under one numbering, so one query per request. `open` reads OpenAI's crawl index: `external_web_access` does not change the `Crawled:` age, and an unindexed URL yields `… is not accessible via this tool.`; `http://` URLs are upgraded to `https://`. Windows carry `L<n>:` lines (PDF: `L<n>@P<page>:`), a `Total lines: N` note, and a backfill of about a third of the window before `lineno`; `lineno` beyond the end returns the last window. Failures are HTTP 200 with `output` starting `Internal Error ()` and an `L0:` line of the form `Failed to fetch <url>: (<code>) <reason>`, `… is not accessible via this tool.`, or `Unable to resolve open call due to invalid ref_id argument`.
- Responses `web_search` (Codex and Grok groups) honours `filters.allowed_domains` / `blocked_domains` (Grok: `excluded_domains`), `user_location`, `include: ["web_search_call.action.sources"]`; Grok's `x_search` (handles, dates) rejects any `include`; its post retrieval shows up as a `custom_tool_call` named `x_thread_fetch`, its text contains private markers such as `render_inline_citation`, "verbatim" output is a model rendition, and a missing post leaves `num_server_side_tools_used` at 0 with no `url_citation`. Grok reports `usage.cost_in_usd_ticks`; the unit 1e-10 USD is inferred from the magnitude. One Grok request takes 17–105 s and costs $0.03–0.25.
- Anthropic server tools on `/v1/messages` pass through untouched (filters, `max_uses`, `user_location`, beta headers not required). `web_search_20250305` and `web_search_20260209` + `allowed_callers: ["direct"]` return identical results; any `_2026xxxx` tool without `allowed_callers: ["direct"]` is routed through code execution, which this instance rate-limits (one fetch burned 72k tokens with no page). `web_fetch_20250910` serves cached copies (`retrieved_at` 20 days old for a PDF); `web_fetch_20260309` with `use_cache: false` and `allowed_callers: ["direct"]` fetches live. A PDF comes back as the complete file in base64 (2.9 MB, 35k input tokens); an X post fails with `url_not_allowed`; `allowed_domains` and `blocked_domains` together are a 400. If the gateway's local search emulation is enabled, tool-use ids start with `srvtoolu_ws_` and filters are ignored.
- The gateway treats a client function tool named `web_search` / `x_search` / `tool_search` on the Grok group specially: every such `function_call` is counted as a native search in its accounting (+$0.005 measured), and on Grok OAuth accounts it recognises as free the tools are replaced by native search (source only; not triggered on this instance). Codex and Claude groups pass client tools through unchanged.

**DeepSeek**: `POST /v1/tools/search` ({query ≤ 128 characters including operators, count 1–50, need_content}) and `/v1/tools/fetch`; `site:` is a soft preference (`site:x.com` returned codedtx.com; reddit and x.com are not indexed), `-site:`, `after:`, `before:`, `lang:` work; `summary` runs to 2–5k characters; `date` has day precision; fetch returns markdown with backslash-escaped punctuation and lost inline-code backticks, 3–11 s, 404 for reddit, X and PDFs; search 0.2–0.6 s; $0.75 per 1000 calls from 2026-11-01.

**Exa**: `includeDomains` / `excludeDomains` are hard and include subdomains and path prefixes (`*.example.com` excludes the root); `startPublishedDate` drops undated pages while `endPublishedDate` alone keeps them; `userLocation` has no observable effect; `category` accepts only `company`, `publication`, `news`, `personal site`, `financial report`, `people` (`tweet` is a 400); reddit and x.com are blocked by policy (0 results, `SOURCE_NOT_AVAILABLE` 403 on fetch); `highlights` are the only snippet text and are free inside a search; `lite` costs $0.004 per ≤10 results (0.6 s warm), `auto` $0.007 (1.5–2.2 s); `/contents` serves cache (`source: "cached"`, 0.3 s) unless `maxAgeHours` requires a crawl (`crawled`, 1.3 s), $0.001 per page and view, PDFs supported, no final URL; 10 requests per second, then 429 with `Retry-After`; a missing key is a 402.

**Repository rules** (`docs/conventions.md`, `docs/architecture.md`): `src/index.ts` is wiring only; logic in modules; tests are end-to-end through `startPi` with fixtures in the package's `test/`; no `console`; host packages as peers; configuration under `getAgentDir()`; `defineTool` with TypeBox and `StringEnum`.

## Goals / Non-Goals

**Goals:**
- Adding a provider type is one module plus one registry entry; the routing engine, post-processing and tools never change for it.
- Every call tells the model which provider answered, what was tried, what was degraded, and how the text was obtained.
- Both tools work identically in TUI, print, JSON and RPC modes and inside codemode scripts.
- No credential is read from another extension's files, written to disk, or echoed in an error.

**Non-Goals:**
- Injecting headers into the session's own model requests (the Grok gateway interaction is documented, not worked around).
- Extracting text from PDFs in-process, running a local HTTP fetcher, caching results, fusing or re-ranking results across providers, or running providers in parallel.
- Exposing provider-specific knobs as tool parameters; they live in the configuration file.

## Decisions

### D1. Two always-registered tools with a plain-string `provider` override

`web_search` and `web_fetch` are registered in the factory regardless of configuration (the configuration is read in `session_start`, as pi-retry does, so the factory cannot know the provider names). `provider` is therefore `Type.String()` validated in `execute` against the loaded configuration; an unknown name fails with the list of configured names. A `StringEnum` built from the configuration was rejected: it would require reading the file in the factory, and an empty enum renders as `never` in codemode and may be rejected by providers. The tool names follow the user's decision (`web_search`, `web_fetch`); the consequences on the Grok group are documented in the README and listed under Risks.

### D2. Provider adapters behind one interface

```ts
interface WebProvider {
  search: { domains: "hard" | "soft"; maxCount: number; recency: boolean; content: boolean };
  fetchExtraction: "verbatim" | "model";
  runSearch(request: SearchRequest, run: RunContext): Promise<ProviderSearchResult>; // warnings in the result
  runFetch(request: FetchRequest, run: RunContext): Promise<ProviderFetchResult>;    // text from the page start, `complete`
}
```

`RunContext` carries the resolved credentials and the attempt's abort signal. Adapters live in `src/providers/<type>.ts`; each exports a `ProviderDefinition` (required fields, defaults, option specs, `create(entry)`), collected in the registry `Record<ProviderType, ProviderDefinition>` (`src/providers/registry.ts`). Shared clients: `src/clients/responses.ts` (streaming Responses request, SSE parsing into output items, failure detection) used by `sub2api-codex` and `sub2api-grok`; `src/clients/messages.ts` (Anthropic Messages request and block parsing) used by `sub2api-claude`; `src/clients/http.ts` (JSON request with timeout, status mapping, credential redaction). Adapters hold no state beyond their entry; results are plain data so the routing engine and post-processing can be tested through any adapter.

### D3. Every provider implements both capabilities

Required by the proposal. Native verbatim fetchers: `sub2api-search` (alpha `open`), `sub2api-claude` (`web_fetch_20260309`), `deepseek`, `exa`. Model-mediated fetchers: `sub2api-codex` and `sub2api-grok` open the page inside the Responses `web_search` tool with an instruction to return the text verbatim, and `sub2api-grok` retrieves X posts through `x_search`; both label `extraction: "model"` and add the rendition warning. The README's recommended `fetch` chain puts verbatim providers first; the model-mediated ones matter when a site rule or override selects them (X posts are reachable only this way).

### D4. Credentials from Pi's registry, key expressions resolved in-package

For an entry with `provider`: pick the configured `model` if `find(provider, model)` succeeds, otherwise the first model of `getAll()` with that provider id; call `getApiKeyAndHeaders(model)`; use `resolved.apiKey`, `resolved.headers`, and `entry.baseUrl ?? <type default> ?? resolved.baseUrl ?? model.baseUrl` as the endpoint base (an explicit `baseUrl` wins; DeepSeek and Exa have fixed defaults that Pi's model base must not override). `getProviderAuth` is not used because it throws. For an entry with `apiKey`: a small resolver implements Pi's documented grammar (literal; `$NAME`/`${NAME}`; `!command` run through the user's shell (`$SHELL -c`, else `/bin/sh`) bounded by the provider's `timeoutMs` (a 1Password approval can take longer than a fixed few seconds; the live check timed out at 10 s), trimmed stdout; a timed-out command is not cached, so the next use runs it again; `$$` and `$!` escapes). Resolution happens on first use and the outcome (key or failure reason) is cached in the session-scoped provider state, so `!op read …` prompts once per session. Waiting for a key (or for Pi's registry) ends with the attempt's signal, so the provider's `timeoutMs` and Escape bound it; the command itself keeps running after a cancellation (Escape) and settles the cache for the next call. A command that reaches `timeoutMs` is ended together with its process group (it runs detached in its own group), its timeout settles the result at once, and that result is not cached, so the next use runs it again; a timeout left by an earlier, cancelled call makes the current attempt start its own command rather than inherit the old one's remaining time. The undocumented trick of registering a credential-only provider in `models.json` to reuse Pi's resolver was rejected (undocumented, visible in `/login`). The DeepSeek adapter defaults `provider` to `deepseek` so Pi's stored key is reused; Exa defaults `apiKey` to `$EXA_API_KEY`.

### D5. Routing engine

`src/routing.ts` exports `planChain(config, target, override?): { chain, rule?, fallback }` (pure: `site:` extraction already applied; rule matching per the `provider-routing` spec against the request's domains or the URL; override short-circuits) and `runChain(plan, attempt, options)` which iterates, classifies outcomes (`ok`, `empty`, `error`, `skipped`), records latency, calls `onUpdate` with `"<provider> failed (<reason>); trying <next>"`, and stops on abort. Each attempt runs under `AbortSignal.any([signal, AbortSignal.timeout(entry.timeoutMs)])`. Credential failures are `skipped` before any request. A domain-restricted search whose filtered results are empty is `empty` and continues; everything else follows the spec. The override path uses the same executor with a one-element chain and `fallback: false`.

### D6. Post-processing pipeline

`src/sites.ts` holds the site-pattern matcher (suffix, host-with-subdomains, path prefix on segment boundaries; hosts case-insensitive, paths case-sensitive; `twitter.com` read as `x.com`) used by both rules and result filtering, plus URL normalisation (lower-case scheme/host, strip fragment, strip `utm_*`, `fbclid`, `gclid`). `src/search-tool.ts` runs: parse `site:` / `-site:` operators out of the query → plan → for each attempt, ask the adapter for `maxResults × 3` (capped by the adapter's maximum) when its `domains` capability is `soft`, otherwise `maxResults` → host filter → normalise and deduplicate → cut to `maxResults` → truncate `snippet` (500) and `content` (4000) with a marker and a `web_fetch` hint → assemble `attempts`, `warnings`, `costUsd`, `latencyMs`. `src/fetch-tool.ts` slices the provider's full text by `offset`/`maxChars` and sets `truncated`/`nextOffset`/`totalChars`; adapters that page natively (alpha) stop requesting windows once `offset + maxChars` is covered and report `totalChars` only when the page ended.

### D7. Per-provider mapping

| Type | Search | Fetch |
|---|---|---|
| `sub2api-search` | one `search_query` per request; `recency` → days (1/7/30/365); `domains` → `search_query[].domains` (hosts); path-less `excludeDomains` → `settings.filters.blocked_domains` (path exclusions stay client-side, here and for every host-only backend); `response_length: "short"`; `settings.user_location` from options; never `max_output_tokens`, `search_context_size`, `allowed_domains`; fresh `id` per request | `open` with `response_length: "long"`, windows by `lineno = maxSeen + 1`, lines deduplicated by number; header line → `title`/`finalUrl` (the endpoint upgrades `http://` to `https://`, and a site without HTTPS then fails as `502 Bad Gateway`); `Crawled:` → `crawledAt`; `【id†text†host】` → `text`; `@P<n>` → `## Page n+1`; `Internal Error ()` text → reason classes `<code> <reason>`, `not indexed`, `invalid ref`; `totalChars` known only when the last window was reached |
| `sub2api-codex` | Responses `web_search` with `filters` (hosts of `domains`, path-less exclusions), `user_location`, `search_context_size` from options, `tool_choice: "required"`, `include` sources, `stream: true`, `store: false` | Responses `web_search` with an open-and-quote instruction; accepted only with an `open_page` action for the URL |
| `sub2api-claude` | `web_search_20250305`, `max_uses` (option, default 3), `allowed_domains` or `blocked_domains` (never both; exclusions client-side when both requested), `user_location` option; results from `web_search_tool_result`, snippets from `cited_text`; `srvtoolu_ws_` ids → emulation warning | `web_fetch_20260309` with `use_cache: false`, `allowed_callers: ["direct"]`, `allowed_domains: [host]`, `max_content_tokens = 3 × (offset + maxChars)` (a token is at least one byte and a UTF-16 code unit at most three, so a document shorter than `offset + maxChars` characters cannot have been cut; a longer one may continue); `.pdf` URLs skipped (`unsupported: pdf`), `application/pdf` documents failed |
| `sub2api-grok` | X-only `domains` → `x_search` (`allowed_x_handles` from `x.com/<handle>` paths, `excluded_x_handles` from `excludeDomains`, `from_date` from `recency`), no `include`, and `x.com/i/status/<id>` citations rewritten to `x.com/<handle>/status/<id>` when exactly one handle was searched; otherwise `web_search` with `filters.allowed_domains` or (without domains) `excluded_domains` and `include` sources, warning when exclusions move to the results; citation titles that are numbers or URLs → host or `x.com post <id>`; markers stripped; `cost_in_usd_ticks × 1e-10` | X post URLs → `x_search` asking for the post (`enable_image_understanding` option, default off); missing post rule (`num_server_side_tools_used` 0 and no citation); other URLs as `sub2api-codex` |
| `deepseek` | operators appended in order `site:` (OR-joined), `-site:` (path-less exclusions), `after:`; budget 128 with drop order `-site:`, `site:`, `after:` (dropped filters enforced client-side with a warning); `count = min(50, maxResults × 3)` when `domains` present; `need_content` with `includeContent`; `date` → `publishedAt`, `rerank_score` → `score` | `/tools/fetch`; un-escape `\` before punctuation; non-2xx → reason with DeepSeek's message |
| `exa` | `type` from `searchType` option (`lite` default); `contents.highlights.maxCharacters: 400`; `text.maxCharacters: 4000` with `includeContent`; `includeDomains`/`excludeDomains` verbatim; `startPublishedDate` from `recency` plus the undated-pages warning; `category` option; never `userLocation`; `publishedDate` → date part; `costDollars.total` → `costUsd` | `/contents` with `text.maxCharacters = offset + maxChars + 1` (Exa truncates exactly, so one extra character tells whether the page continues; `totalChars` is reported only when fewer characters came back), `maxAgeHours` option (default 24), `livecrawlTimeout: 15000`; `statuses[0]` decides success, `source` decides `crawledAt`; error tag + `httpStatusCode` as reason |

`recency` → date: `day` 1, `week` 7, `month` 30, `year` 365 days before the current date (UTC), formatted `YYYY-MM-DD`.

### D8. Tool declarations sized for codemode

Descriptions are one or two sentences; every parameter description is one clause; `promptSnippet` is one line per tool; `promptGuidelines` is a single short paragraph ("use `domains` to target a site, `x.com/<handle>` for an account's posts, `provider` only when the user names one"). `outputSchema` properties carry no descriptions. `annotations: { readOnlyHint: true, openWorldHint: true }`. `prepareArguments` parses JSON strings for `domains` and `excludeDomains`. The budgets (4000 characters for descriptions plus parameter JSON; 5000 characters for both declarations inside the codemode description) are asserted by e2e scenarios that read `pi.provider.requests[0].tools`.

### D9. Configuration and command

`src/config.ts` mirrors pi-retry: `emptyConfig()`, `parseConfig(text, source, definitions) → { config, warnings }`, `loadConfig(path, definitions) → { config, warnings, found }`; one warning per problem; entries, chains and rules validated per the `web-access-configuration` spec; type-specific option schemas live next to each adapter and are consulted by the parser through the registry. The file is read in `session_start`; warnings go to `ctx.ui.notify(…, "warning")`, the missing-file notice to `"info"`. `/web-access` renders providers (name, type, capabilities, credential status), chains and rules as plain text through `ctx.ui.notify` in every mode. Session state (`src/state.ts`) holds the parsed configuration, the resolved credentials, and the adapters; `session_shutdown` clears it.

### D10. Tests

Scenarios under `test/*.test.ts` start Pi through `startPi` and never import `src/`. Fixtures under `test/fixtures/`: `server.ts`, one `node:http` server on `127.0.0.1:0` that records every request (path, headers, body, early close) and answers per path from scripted replies (JSON, SSE, delayed, hanging); `backends.ts`, the response bodies of alpha, Responses (SSE), Messages, DeepSeek and Exa, modelled on the live responses captured during research; `session.ts`, the Pi session and tool-call helpers; `codemode.ts` exporting `createCodemodeExtension({ mode: "only" })`. Providers are declared through `agentFiles["models.json"]` with literal keys and the fixture's URL as `baseUrl` (plus `auth.json` for the DeepSeek case), and the extension's configuration through `agentFiles["pi-web-access.json"]`. Assertions use `pi.toolResults()`, `pi.session.subscribe()` for `structuredContent` and progress updates, `pi.ui.notices`, and the fixtures' recorded requests (bodies and headers). Abort is exercised with `pi.session.abort()` while a fixture delays its response. Each scenario is first run against a deliberately broken implementation, as `docs/conventions.md` requires.

### D11. Modules

| Module | Responsibility |
|---|---|
| `src/index.ts` | registers both tools, `/web-access`, `session_start` / `session_shutdown` |
| `src/types.ts` | unified request/result types, provider interface, attempt outcomes |
| `src/config.ts` | file schema, parsing, warnings, defaults |
| `src/credentials.ts` | key-expression resolver, registry lookup, session cache, redaction |
| `src/sites.ts` | site patterns, URL normalisation, host filtering, deduplication |
| `src/routing.ts` | chain planning, rule evaluation, executor with outcomes and timeouts |
| `src/search-tool.ts`, `src/fetch-tool.ts` | tool definitions, parameter handling, post-processing, rendering of `content` |
| `src/clients/http.ts`, `responses.ts`, `messages.ts` | protocol clients shared by adapters |
| `src/providers/sub2api-search.ts`, `sub2api-codex.ts`, `sub2api-claude.ts`, `sub2api-grok.ts`, `deepseek.ts`, `exa.ts`, `registry.ts` | adapters and the type registry |
| `src/command.ts` | `/web-access` rendering |

## Risks / Trade-offs

- [Grok group counts a client tool named `web_search` as a native search (+$0.005) and may replace it on free accounts] → documented in the README; the counting fix belongs in Sub2API; a `before_provider_headers` hook adding `X-Sub2API-Grok-Client-Tool-Cache: off` remains possible later but would not fix the accounting.
- [Model-mediated fetch is slow (40–105 s) and costly ($0.03–0.09) and the text is a rendition] → labelled `extraction: "model"`, last in the recommended chains, used by routing only when a rule or override selects it.
- [Alpha `open` cannot fetch pages outside OpenAI's index and reports age only as text] → `not indexed` falls through to the next provider; `crawledAt` carries the relative age so the model can judge.
- [Exa and DeepSeek return nothing for reddit and X] → domain-restricted empty results continue down the chain; the README's example rules send X to `sub2api-grok`.
- [Grok's cost unit is inferred] → `costUsd` for Grok may be off by a constant factor; the README says it is derived from `cost_in_usd_ticks`.
- [`!command` keys run a shell on first use, possibly prompting (1Password)] → resolved lazily once per session (again after a timeout); a failure marks the provider skipped with the reason and `/web-access` shows it.
- [Configuration edits need `/reload`] → stated in the README and the `/web-access` output.
- [Providers rate-limit bursts (Exa 10 requests/s)] → a 429 is a failed attempt that falls through; parallel tool calls stay rare in practice.
- [Credential leakage through error text] → the HTTP client replaces the key value with `<redacted>` in every error message it raises.
- [Pi 1.3.0 leaves a newly installed extension's tools inactive in resumed sessions] → the host upgrade to 1.4.0 precedes the package.

## Migration Plan

1. Merge the Pi host upgrade pull request (`chore(repo): upgrade Pi host to 1.4.0`).
2. Implement and release the package (`docs/releases.md`).
3. User side: remove `npm:pi-web-access` from Pi's packages, write `<agent-dir>/pi-web-access.json` (README example), install `npm:@zeroclover/pi-web-access`, run `/web-access` to confirm credentials. Rollback is uninstalling the package; nothing else is modified.

## Open Questions

- Whether the Sub2API Grok group ever serves a free Grok OAuth account (which would trigger the name-based tool replacement) is an operational question for the gateway owner; it does not change the design.
