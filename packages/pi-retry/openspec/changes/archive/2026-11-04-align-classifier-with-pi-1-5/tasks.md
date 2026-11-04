# Tasks

## 1. Zhipu/Z.ai 1308 (error-classification: Provider vocabulary, Retry decision by category)

- [x] 1.1 Add these rows to `ROWS` in `packages/pi-retry/test/classification.test.ts`, just before the `// Pi 1.4 additions to its retryable list` comment, under a comment naming Pi 1.5's addition (#11537). `<ZH>` stands for `已达到 5 小时的使用上限。您的限额将在 2026-10-29 02:54:39 重置。`. "Today" is the measured notice on the current code; each row's decision and category are the measured result with the rule:

  | Source | Text | Decision | Category | Today |
  |---|---|---|---|---|
  | Zhipu/Z.ai 1308, code only | `429 {"code":"1308","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code only, numeric form from Pi's pattern, not observed in a response | `429 {"code":1308,"message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | Zhipu/Z.ai 1308 (OpenAI Completions adapter) | `429: {"code":"1308","message":"<ZH>"}` | stopped | `quota` | retried, `rate_limit` |
  | nested body, numeric code (probe variant) | `429 {"error":{"code":1308,"message":"<ZH>"}}` | stopped | `quota` | retried, `rate_limit` |
  | Zhipu/Z.ai 1308 without a status (Google adapter) | `{"code":"1308","message":"<ZH>"}` | stopped | `quota` | retried, `unknown` |
  | Zhipu/Z.ai 1308 (Anthropic adapter) | `429 <ZH>` | stopped | `quota` | retried, `rate_limit` |
  | nested body (pi-messages adapter) | `429 Too Many Requests: <ZH> (1308)` | stopped | `quota` | retried, `rate_limit` |
  | a longer code is not 1308 | `429 {"code":"13080","message":"x"}` | retried | `rate_limit` | same |
  | another Zhipu/Z.ai code is not 1308 | `429 {"code":"1302","message":"x"}` | retried | `rate_limit` | same |

  Verify before touching `src/`: run `pnpm vitest run packages/pi-retry/test/classification.test.ts` from the repository root and confirm it fails with exactly the first seven rows differing, as in the "Today" column. That includes the two code-only rows and the Google row. The `13080` and `1302` rows are guards and must not appear in the failure diff. Record this result for the final report.
- [x] 1.2 Add `{ pattern: /"code"\s*:\s*"?1308(?![0-9])|使用上限/i, category: "quota" }` to the quota group of `DETERMINISTIC_RULES` in `packages/pi-retry/src/vocabulary.ts`, after `available balance` (design D1). Add Zhipu/Z.ai's code 1308 (#11537, Pi 1.5) and `使用上限`, which some adapters render without the code, to the group's source comment (lines 59-61). Verify that `pnpm vitest run packages/pi-retry` passes with every 1.1 row and no other row edited.
- [x] 1.3 In the `quota` row of `packages/pi-retry/README.md` (line 106), add after `available balance`: ``Zhipu/Z.ai code `1308` (`"code":"1308"` or `"code":1308`), `使用上限` ``. Verify that the row names every alternative of the 1.2 rule.

## 2. Statements about Pi 1.5

- [x] 2.1 Replace the examples in the `context_overflow` row of `packages/pi-retry/README.md` (line 111) with exactly: ``Pi's overflow patterns (`prompt is too long`, `exceeds the context window`, `Context Window exceeded` since Pi 1.5, an error text starting with `413` or `<provider> API error (413):` since Pi 1.4, …), `context_length_exceeded`, `ContextWindowExceededError` (the class name alone, which Pi does not match), `request_too_large` (handled by Pi's compaction)``. Verify with `rg -n "the class name alone" packages/pi-retry/README.md`, and that the table still renders as one row.
- [x] 2.2 Add these rows to `ROWS` under the `// LiteLLM proxy` group. They are guards and pass before and after this change. The `category` value also names the evidence, which the row's matcher takes as a regular expression prefix of the notice, so the two paths can be told apart (design D6). Say so in the comment on the `category` field of the `Row` interface, not only beside these rows:

  | Source | Text | Decision | Category |
  |---|---|---|---|
  | LiteLLM class name alone: this rule, not Pi's pattern | `litellm.ContextWindowExceededError` | stopped | `context_overflow: ContextWindowExceeded` |
  | underscore form: this rule, not Pi's pattern | `context_window_exceeded` | stopped | `context_overflow: context_window_exceeded` |
  | LiteLLM pre-call check: Pi's pattern since Pi 1.5 | `litellm.ContextWindowExceededError: litellm.BadRequestError: litellm._pre_call_checks: Context Window exceeded for given call. No models have context window large enough for this call.` | stopped | `context_overflow: Pi's overflow patterns` |

  Then update the overflow comments in `packages/pi-retry/src/vocabulary.ts` (lines 31-36) to say that since Pi 1.5 `isContextOverflow` recognises LiteLLM's prose `Context Window exceeded`, while the `context.?window.?exceeded` rule still classifies the bare class name and the underscore form, which Pi's pattern does not match (design D4). Verify that `git diff` shows no change to that rule's pattern and that `pnpm vitest run packages/pi-retry` passes.
- [x] 2.3 Change the Codex reference in the comment at `packages/pi-retry/src/vocabulary.ts:80` to `openai-codex-responses.js:1245-1257`. Verify with `rg -n "let friendlyMessage|friendlyMessage = .You have hit" packages/pi-retry/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js`, which must print lines 1245 and 1257.
- [x] 2.4 Verify the version statements with `rg -n "Pi 1\.[0-9]" packages/pi-retry/README.md packages/pi-retry/src packages/pi-retry/openspec/changes/align-classifier-with-pi-1-5/specs`. Every `Pi 1.4` it prints must be one of the historical references that design D5 keeps: the README's 413 note, `src/vocabulary.ts`'s notes on #11057/#10996 and #10920, and the scenario title "Gateway and stream failures added in Pi 1.4". The delta's "checked against" and "built-in lists" statements must read Pi 1.5.

## 3. Release and verification

- [x] 3.1 Record the release decision from the repository root: `pnpm change --bump patch --summary "Zhipu/Z.ai plan usage limits (error code 1308, or 使用上限 in the message) now count as quota: without an accepted retry hint they stop instead of being retried until maxRetries runs out." @zeroclover/pi-retry`. Verify with `pnpm change status`.
- [x] 3.2 Run `pnpm check` from the repository root and make sure it passes. Run `openspec validate align-classifier-with-pi-1-5 --strict` from `packages/pi-retry/` and make sure it passes. Report both as run. Also report that no request reached a real Zhipu/Z.ai endpoint, since a real 1308 needs an exhausted plan: the scenarios use the scripted provider, with texts captured from Pi's adapters against a local HTTP server.

## Workflow follow-up

- Archive the change after review, syncing the delta into `packages/pi-retry/openspec/specs/error-classification/spec.md`. Then confirm that the main spec's "checked against" and "built-in lists" statements read Pi 1.5.
- Commit in the Pi 1.5 upgrade pull request as `fix(pi-retry): classify Zhipu 1308 as quota and align with Pi 1.5`, when a commit is requested.
