# Design

## Context

See proposal.md "Why" for the symptoms. The facts below were read and measured on Pi 1.5.0.

**How a tool call's arguments are handled**

- `pi-agent-core/dist/agent-loop.js:474-498`: `prepareArguments` runs first, then `validateToolArguments` on what it returned. Pi's docs say the same (`docs/extensions.md:2302`).
- `pi-ai/dist/utils/validation.js`: validation compiles the schema with pi-schema's `coerce: true`. Its first pass (`pi-schema/dist/coerce.js:107,138`, `dropOptionalNulls`) removes a `null` in a property that is not required and whose schema rejects `null`. A `null` for a required string becomes `"null"` (pi-schema README).
- `web_search` has its own `prepareArguments` (`src/search-tool.ts:67-83`), which calls TypeBox's `Value.Convert` and then `Value.Check`. `Value.Convert` is what acts on the nulls before Pi's first pass can see them: `domains` becomes `["null"]`, `maxResults` `0`, `provider` and `query` `"null"`, `includeContent` `false`; `recency`, whose schema is a plain string enum, fails `Value.Check`.
- The same function's string step wraps a `domains` or `excludeDomains` string that does not parse to an array into a one-entry list. `parseJson` returns `undefined` when the text is not JSON and `null` for the text `null`, so the string `"null"` becomes `["null"]`, the same value as above, and reaches the backend as `q site:null` or `q -site:null` (measured).
- `web_fetch` has no `prepareArguments`, so Pi's pass applies: `offset`, `maxChars` and `provider` sent as `null` act as omitted. `url: null` becomes `"null"` and fails at the tool's URL check (`only http and https URLs are supported`) with no provider contacted. Measured: with all three optional nulls on a 30 000-character page the result covers characters 0-20000 with `nextOffset: 20000`.
- Codemode scripts go through the same path: before the fix, `tools.web_search({ query: "q", domains: null, maxResults: null })` in a script fails with `/maxResults must be >= 1`; with the fix below it runs with `{ query: "q", count: 5 }`. Task 1.6 guards this path with a scenario.

**How the system prompt is built**

- `pi-coding-agent/dist/core/system-prompt.js:85`: each `<tools>` line is `` `- ${name}: ${toolSnippets[name]}` ``, so Pi adds the name.
- `system-prompt.js:65`: each `<rules>` line is `` `- ${rule}` ``, so Pi adds no name. `docs/extensions.md:1590,2172` state that a guideline has no tool name prefix and must name its tool.
- The specs and README do not describe the snippets. `test/declarations.test.ts` asserts declaration sizes and codemode text, not snippet text, so no existing assertion changes. No other package in the repository sets `promptSnippet` or `promptGuidelines`.

## Goals / Non-Goals

**Goals:**

- A `null` top-level argument to `web_search`, and a `domains` or `excludeDomains` string holding JSON `null`, mean "not sent", on every call path.
- `query: null` is a validation error.
- Each tool is named once in `<tools>`.

**Non-Goals:**

- Providers, routing, parameter schemas, and any other coercion. A regression assertion keeps a non-null coercion in place: `maxResults: "3"` still requests 3 results.
- `null` as an array element: `domains: [null]` and `domains: "[null]"` still reach the backend as `q site:null` (measured). The null here is an element of a list the model did send, not a parameter it meant to omit, and no model has been observed sending it, so handling it would add element-level rules for an input nobody has reported.
- `web_fetch` code other than its snippet. Its null handling is Pi's; this change only records it in the spec and guards it with a scenario.
- Removing `prepareArguments` or the `Value.Convert` it contains.

## Decisions

### Drop every top-level `null` before `Value.Convert`

`prepareArguments` builds its working copy without the null properties, in place of today's `{ ...args }`:

```ts
const prepared = isRecord(args)
	? Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null))
	: args;
```

A missing `query` then fails the existing `Value.Check` with the existing message, `Invalid web_search arguments: / must have required properties query`, the same result as a call that never sent `query`. The transcript keeps the model's original arguments, since this is a copy. A comment states why the nulls are dropped here: Pi would drop them only after this function, and `Value.Convert` would first turn them into values.

Measured in a scratch copy of this tree on Pi 1.5.0, with both null fixes and the new snippets applied: every case in the proposal's table behaves as the specs require, draft versions of the scenarios in `tasks.md` fail before the fix where the tasks say they do and pass after it, Biome and `tsc` report no error in `src/`, and the package's 66 existing tests still pass.

Alternatives considered:

| Option | Result | Verdict |
|---|---|---|
| The trial fix: delete nulls except `query` | `query: null` reaches `Value.Convert`, becomes `"null"`, passes `Value.Check`, and a search for `null` runs (measured). Fails the requirement. | Rejected |
| Delete only keys that `parameters` declares optional | The same outcome for `query`, so it needs a separate check, and it reads the schema to reach the behavior that dropping all nulls gives directly. Its one difference, keeping an undeclared key's null, has no effect: undeclared keys are ignored either way. | Rejected |
| Trial fix plus an explicit `query === null` throw | Meets the requirement, at the cost of a second code path and a second error message for "query is missing". | Rejected |
| Remove `Value.Convert` and `Value.Check` and rely on Pi's validation | Pi would drop optional nulls itself, but `query: null` would still become `"null"`, and the coercion and error wording of every other parameter would change. | Rejected: a non-goal, and it does not meet the requirement |

If a parameter ever needs to distinguish `null` from "not sent", this code must change with it; no parameter does today, and the schema accepts no null.

### Treat a JSON-encoded null domain filter as omitted

The string step in `prepareArguments` gets one more case:

```ts
const parsed = parseJson(value);
if (parsed === null) delete prepared[key];
else prepared[key] = Array.isArray(parsed) ? parsed : [value];
```

The symptom is the same as a real `null`, and the fix sits in the only place that parses these strings. The comparison must be strict: `parsed == null` or `!parsed` would also match `undefined`, and a bare `domains: "example.com"`, which is not JSON, would lose its filter. A scenario assertion guards that case.

Only `domains` and `excludeDomains` go through JSON parsing, so the rule stops there. `query: "null"` stays an ordinary search term, because `null` can be a legitimate thing to search for, while `site:null` is never a useful filter. `provider: "null"` stays an unknown provider error.

### Remove the name from the snippets; leave the guideline

The snippets become `Search the web; filter by site with domains` and `Read a URL as text; continue long pages with nextOffset`, capitalized like Pi's built-in snippets (`Read file contents`). The system prompt then reads `- web_search: Search the web; …`, measured in the scratch copy. The guideline keeps its `web_search:` start, because Pi adds no prefix to it and its docs require the tool to be named; it is one occurrence, not a duplicate.

### One spec requirement for the snippets, in `web-search`

The specs do not mention snippets, but the repeated name is model-visible behavior and the conventions require a scenario to cite a requirement. `web-search` already holds a requirement covering both tools ("The search declaration stays small"), so the new requirement sits there and `web-fetch` gets no second copy. It constrains the shape of the entry and not its wording, and so does the scenario: a snippet can be reworded without breaking the test, but one that mentions its own tool, such as `Search the web with web_search`, fails it.

"Names each tool once" applies to the `<tools>` entries only. A `<rules>` guideline that names `web_search` is not a violation: Pi adds no prefix there, and `docs/extensions.md:1590,2172` require each guideline to name its tool.

### Record `web_fetch`'s null behavior in `web-fetch`

The host produces this behavior, not this package, but the tool's callers rely on it, so it belongs in the spec. If a host upgrade changes it, this package's test must fail, so that the upgrade has to deal with it instead of shipping `web_fetch` with a changed contract. The scenario passes on the current code, so it is shown to work against a deliberate break: a temporary `prepareArguments` on `web_fetch` that runs `Value.Convert` gives `maxChars: 0` and a validation error (measured).

## Risks / Trade-offs

- [The system prompt text changes for every session with these tools] → The change only removes repeated words, and the tool declarations stay the same.
- [`query: null` used to return results and now fails] → That call searched for the word `null`, so no caller depends on the result; the error names the missing parameter and the model can retry.
- [Null array elements still produce `site:null`] → Not observed from any model; recorded under Non-Goals so that it stays visible.
