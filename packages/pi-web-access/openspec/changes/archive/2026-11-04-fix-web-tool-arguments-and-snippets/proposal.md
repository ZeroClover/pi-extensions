# Proposal

## Why

Models often send `null` for a parameter they mean to omit, and `web_search` turns that into a wrong request or a needless error: its `prepareArguments` runs `Value.Convert` before Pi gets to drop optional nulls, so `domains: null` reaches the backend as `q site:null` and every result is filtered away. Separately, both tools' `promptSnippet` repeats the tool name that Pi already prints, so the system prompt reads `- web_search: web_search: search the web…`. Both problems exist on Pi 1.4 and 1.5.

Observed on Pi 1.5.0 through real Pi sessions against a fixture backend:

| Arguments | Today |
|---|---|
| `domains: null` | backend receives `q site:null` (15 results requested), all dropped by the client-side filter |
| `excludeDomains: null` | backend receives `q -site:null` |
| `domains: "null"` | backend receives `q site:null` (15 results requested), all dropped by the client-side filter |
| `excludeDomains: "null"` | backend receives `q -site:null` |
| `maxResults: null` | error `/maxResults must be >= 1` |
| `recency: null` | error `/recency must be string; …` |
| `provider: null` | error `unknown provider "null"` |
| `query: null` | **no error**: a search for the word `null` runs |

The last row matters: a null `query` is not rejected today, so this change introduces that rejection rather than preserving it.

## What Changes

- `web_search` treats a top-level argument whose value is `null` as omitted. Optional parameters then behave exactly as if they had not been sent.
- `web_search` treats `domains` or `excludeDomains` sent as the JSON-encoded string `"null"` the same way. Its string-parsing step otherwise wraps that string into a one-entry list, with the same `site:null` result as a real `null`.
- `web_search` fails `query: null` with a validation error, without contacting a provider.
- The `web_search` and `web_fetch` prompt snippets no longer start with the tool's name, so each tool is named once in the system prompt's `<tools>` section. Prompt guidelines keep their tool name: Pi does not add one to them, and its documentation requires them to name the tool.
- The specs record `web_fetch`'s existing null handling, which Pi already provides. Apart from its snippet, `web_fetch`'s code does not change.

Not changed: providers, routing, the tools' parameter schemas, and every other argument coercion, which includes `null` as an array element (`domains: [null]` and `domains: "[null]"` still yield `site:null`; see `design.md`, Non-Goals).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-search`: null arguments, and JSON-encoded null domain filters, count as omitted, and a null `query` is a validation error; both tools are named once in the system prompt's tool list.
- `web-fetch`: records that null optional arguments count as omitted and that a null `url` fails without contacting a provider (existing behavior).

## Impact

- `src/search-tool.ts`: `prepareArguments` and `promptSnippet`. `src/fetch-tool.ts`: `promptSnippet`.
- `test/tools.test.ts`, `test/declarations.test.ts`: new end-to-end scenarios.
- Model-visible: the system prompt text changes for both tools. The tool declarations do not change.
- No dependency, configuration, or README change: the README's parameter tables already document these parameters' defaults, and it does not mention snippets.
- Release: patch for `@zeroclover/pi-web-access`.
