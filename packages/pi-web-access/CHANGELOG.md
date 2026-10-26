# @zeroclover/pi-web-access

## 0.1.0

### Minor Changes

- First release: `web_search` and `web_fetch` tools over Sub2API (alpha search, Codex, Claude and Grok groups), DeepSeek and Exa providers, with a priority chain and fallback, site rules (for example X to Grok, `.cn` to DeepSeek), a per-call provider override, and `/web-access` to inspect providers and credential status. Remove the third-party `pi-web-access` package before installing: it registers a `web_search` tool too, and Pi refuses duplicate tool names.
