# Tasks

## 1. Test harness

- [x] 1.1 Add two optional fields to the scripted `Response` in `tools/e2e/src/provider.ts` (design D5), documented like `model`:
  - `api`: the adapter the assistant message names, defaulting to the requested model's API. The `Streamer` uses `response.api ?? requested.api`.
  - `priorResponses`: `{ status, headers }` entries that `onResponse` reports, in order, before the response's own.
  - `failure()` accepts and forwards both.

  Verify that `pnpm check` passes with every existing scenario unchanged. Then check that the overridden `api` reaches `message_end` unchanged: the 2.1 scenarios must fail for the gate reason, not because Pi rewrote the message's `api`.

## 2. Header capture gate (retry-hints: Header capture gate)

- [x] 2.1 Add two scenarios to `packages/pi-retry/test/hints.test.ts`, both with `cacheWarming: "off"`:
  - A `bedrock-converse-stream` failure that reports a 429 with `retry-after: 1` in `priorResponses` and another as its own response gets backoff and no `hintSource`. A following failure on the scripted adapter with one 429 and `retry-after: 1` still gets `header retry-after`.
  - An `openai-codex-responses` failure whose error text is `You have hit your ChatGPT usage limit.`, with one 429 and `retry-after: 1`, gets category `rate_limit`, `hintSource: "header retry-after"` and `delayMs: 1250`. This needs task 3.2 for the category; run it after 3.2, or assert only the hint first.

  Verify with `pnpm vitest run packages/pi-retry` that both fail on the current code.
- [x] 2.2 In `src/capture.ts`, exclude `bedrock-converse-stream` instead of `openai-codex-responses`, and rewrite the doc comment to give the reason (the AWS SDK's own retries). Update the comment in `src/index.ts` that names Codex. Change the warming gate reason from `a cache-warming request ran in this session` to `a cache-warming decision occurred in this session`, and fix the comment above `warmingDecision`: Pi emits `cache_warming_decision` also for decisions that end in `stop`. Verify that both 2.1 scenarios and the rest of the package's scenarios pass.
- [x] 2.3 Correct the "Header hints" section of `packages/pi-retry/README.md`:
  - The adapter table:
    - Bedrock leaves the "not delivered" row and gets a row of its own: delivered once per AWS SDK attempt, and never used because the gate excludes it. The first row then lists only adapters whose header hints work.
    - "Gemini CLI" is removed.
    - The Codex entry reads "OpenAI Codex requests served over SSE (the `sse` transport, or `auto` after a WebSocket fallback)".
  - The gate list:
    - The Bedrock rule replaces the Codex rule.
    - The `retry.provider.maxRetries` bullet loses its "(no SDK retries inside a single request)" parenthetical, or says that only provider-level retries are meant and the AWS SDK's own retries are covered by the Bedrock rule.
  - Document the Bedrock trade-off from design.md "Non-Goals": a failure the AWS SDK does not retry loses its header hint.
  - The project-level `cacheWarming` caveat: the gate closes on the first warming decision, not the first warming request.

  Verify that every row matches design.md "Context".

## 3. Vocabulary (error-classification: Provider vocabulary, Deterministic categories take precedence)

- [x] 3.1 Add rows to the `ROWS` table in `packages/pi-retry/test/classification.test.ts`:
  - One row for each of the six Pi 1.4 wordings in the spec scenario "Gateway and stream failures added in Pi 1.4", with its expected category.
  - The Anthropic low-credit text, as `quota` / not retrying.
  - `You have hit your ChatGPT usage limit (plus plan).`, `You have hit your ChatGPT usage limit.` and `You have hit your ChatGPT usage limit (plus plan). Try again in ~0 min.` as `rate_limit` / retried.
  - One of them with a `provider_transport_failure` diagnostic whose `error.code` is `ECONNREFUSED` (scripted through `failure()`'s `diagnostics`), also `rate_limit` / retried.

  Verify that they fail on the current code, through their category.
- [x] 3.2 Add the D3 rows to `TRANSIENT_RULES` in `src/vocabulary.ts`, with source notes citing the Pi issues. Move the quota group ahead of the invalid_request group in `DETERMINISTIC_RULES` and update its comment. Export the D7 anchored Codex rule from `src/vocabulary.ts` on its own, outside `DETERMINISTIC_RULES`, with a source note citing `openai-codex-responses.js:1250-1262`. In `categorise` in `src/classify.ts`, check it against `message.errorMessage` after the overflow check and before `DETERMINISTIC_RULES`. Verify that 3.1 passes and that no existing classification row changes.
- [x] 3.3 Update the README "Error categories" table:
  - Add the new transport and server_error wording.
  - List `subscription_sharing_workplace_individual_usage_limit_exceeded` under quota.
  - In the precedence rules, state that quota wording beats invalid-request wording, and that Pi's Codex usage-limit message without a usable reset time is `rate_limit` although deterministic wording otherwise beats transient wording.
  - Add Pi's Codex `You have hit your ChatGPT usage limit.`, without a reset time or with `~0 min`, to the `rate_limit` row, change the hints list's "(`~0 min` is ignored)" to "(`~0 min` is retried with backoff)", and qualify the quota row's `usage limit` (ChatGPT) to the message that carries `Try again in ~N min.`.

  Verify against `src/vocabulary.ts`.

## 4. Statements about Pi

- [x] 4.1 Rewrite the intro of `packages/pi-retry/README.md`:
  - Pi checks a deny list before an allow list, after its overflow check.
  - Its waits are capped by `retry.maxAgentDelayMs` (60 s by default).
  - Only provider-level retry honours `retry-after`.
- [x] 4.2 Rewrite the README header-to-text bridge paragraph:
  - Codex over SSE also produces `Server requested …`, without the trailing error.
  - The extra provider retry waits 375–500 ms, or 1 s on Codex.
  - On Codex, a `retry-after` header replaces the usage-limit text only on an HTTP error that Codex's `isRetryableError` accepts (`openai-codex-responses.js:52-62, 291`): a 429 without terminal quota or billing wording, a 500/502/503/504, or any status whose body matches its rate-limit, overload, unavailable or connection wording.
  - "Which affects only the adapters in the first row above" becomes "the adapters in the first row", with Bedrock no longer in that row.
- [x] 4.3 Verify the result:
  - Run `rg -n "Pi [0-9]" packages/pi-retry/README.md packages/pi-retry/openspec/specs packages/pi-retry/openspec/changes/align-with-pi-1-4/specs` and make sure every line it prints names Pi 1.4. Historical references, such as "written against Pi 1.3.0" in proposal.md and design.md, are intended and are not part of this check.
  - Run `rg -n "Gemini CLI|single regular expression|codex-responses.*retries internally" packages/pi-retry` and make sure it returns nothing outside `openspec/changes/`.

## 5. Release and verification

- [x] 5.1 Record the release decision from the repository root: `pnpm change --bump patch --summary "<user-facing summary: Bedrock throttles no longer turn header hints off for the session; Codex over SSE honours retry-after headers; Pi 1.4's gateway and stream errors get a category; low-credit errors read as quota; README corrected for Pi 1.4>" @zeroclover/pi-retry`. Verify with `pnpm change status`.
- [x] 5.2 Run `pnpm check` from the repository root and make sure it passes. Run `openspec validate align-with-pi-1-4 --strict` from `packages/pi-retry/` and make sure it passes. Report both commands as run.

## Workflow follow-up

- Archive the change, syncing the deltas into `packages/pi-retry/openspec/specs/`.
- Commit as `fix(pi-retry): align header gate and vocabulary with Pi 1.4`, with the `tools/e2e` change in the same pull request.
