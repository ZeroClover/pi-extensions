# Design

## Context

See proposal.md, "Why". The facts below shape the design. They were checked against Pi 1.5.0 under `node_modules/@earendil-works/`, by diffing the 1.4.0 copy, and by running copies of the code: `classify` over a 28-row matrix, a real Pi session with the scripted provider, and each adapter's `streamSimple` against a local HTTP server that answers 429.

- **What #11537 reports.** Zhipu/BigModel answers with HTTP 429 and the body `{"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-10-29 02:54:39 重置。"}`. The issue says the OpenAI-compatible (`/api/paas/v4`) and Anthropic-compatible (`/api/anthropic`) endpoints return the same body. It gives no response headers.
- **Pi 1.5's additions that touch the classifier are two lines.**
  - `utils/retry.js` adds `"code"\s*:\s*"?1308(?![0-9])` to the non-retryable list (#11537). The retryable list does not change.
  - `utils/overflow.js` adds `/context window exceeded/i`. It needs the spaces, so `litellm.ContextWindowExceededError` alone and `context_window_exceeded` are still not overflow for Pi.
- **Adapters render a 1308 differently.** With a 429 and #11537's message, against the local server. The first body column is #11537's body. The second is a probe variant that the issue does not report:

  | Adapter | #11537's body `{"code":"1308",…}` | Probe variant `{"error":{"code":"1308",…}}` |
  |---|---|---|
  | `anthropic-messages` | `429 已达到…` **(no code)** | `429 {"error":{"code":"1308",…}}` |
  | `pi-messages` | `429 Too Many Requests: {"code":"1308",…}` | `429 Too Many Requests: 已达到… (1308)` **(no `"code"`)** |
  | `openai-completions` | `429: {"code":"1308",…}` | same |
  | `openai-responses`, `azure-openai-responses` | `<provider> API error (429): {"code":"1308",…}` | same |
  | `mistral-conversations` | `Mistral API error (429): {"code":"1308",…}` | `Mistral API error (429): {"error":{"code":"1308",…}}` |
  | `google-generative-ai` | `{"code":"1308",…}` | `{"error":{"code":"1308",…}}` |

  The two bold cells miss Pi 1.5's pattern: `isRetryableAssistantError` stays true for them. On `pi-messages` the diagnostic's `details.error.code` reaches the classifier only as a bare `1308`, without `"code":`, so it does not help either. `openai-codex-responses` renders the nested body as its own `You have hit your ChatGPT usage limit.`, which Zhipu never meets. The Bedrock probe never reached the local server, so its rendering was not observed.
- **Today's classifier.** The Chinese 1308 forms match no word rule and fall to `rate_limit: HTTP 429`, or to `unknown: no known pattern` on a rendering without a status, such as `google-generative-ai`'s. Both are retried. The English `Usage limit reached…` is already `quota` through `usage.?limit`. In a real session with Pi's retry off and `maxRetries: 2`, the top-level form produced 3 requests, all wasted.
- **The existing precedence already gives the wanted result.** Deterministic wording is tested before specific statuses (`categorise` in `src/classify.ts`), so a new quota row beats the 429. Without a hint, `classify` stops with `quota or billing limit without a reset time`. An attributable `retry-after` header still makes the failure retryable, as it does for every `quota` failure.

## Goals / Non-Goals

**Goals:**
- A 1308 is `quota` on every rendering observed above, including the two that Pi 1.5 misses. Under the existing quota contract it stops unless an attributable `retry-after` header is accepted.
- Every Pi-behavior statement this change touches is true for Pi 1.5.

**Non-Goals:**
- Parsing the reset time (D3).
- Changing control flow or the header gate.
- Adapter-level re-sends under `retry.provider.maxRetries`. They happen inside one request, before pi-retry sees the failure.

## Decisions

### D1. One quota row, after `available balance`

```ts
{ pattern: /"code"\s*:\s*"?1308(?![0-9])|使用上限/i, category: "quota" },
```

The code half is Pi's pattern unchanged. `"?` accepts the numeric form and `(?![0-9])` keeps `13080` out. Both alternatives carry the same meaning and the same source note, so they share one row. `src/classify.ts` does not change.

Two things were checked:

- `STATUS_IN_TEXT` cannot read `"code":1308` as a status, because `(?!\d)` rejects a fourth digit, and `"code":"1308"` has a quote before the digits.
- `isDeterministic` derives from the rule categories, so another quota row does not change it.

Trial run of this rule on a copy, using the author's 28-row probe matrix rather than the test rows in `tasks.md` 1.1: 4 of the 28 rows change, all of them Chinese 1308 forms, from `rate_limit` to `quota` and from retried to stopped. The other 24 do not change. `"code":"13080"` and `"code":"1302"` stay `rate_limit`.

### D2. `使用上限` goes beyond Pi's list

The owner decided to add it. Pi's pattern needs `"code"`, and the two bold renderings in "Context" have none. For them Pi 1.5's `isRetryableAssistantError` is still true, and without this wording pi-retry would retry a limit that resets after hours. The `anthropic-messages` one follows from #11537's report that the Anthropic-compatible endpoint returns the same body. The `pi-messages` one needs the probe's nested body, which nobody has reported from Zhipu; the same wording covers it at no cost. This is a deliberate difference from Pi, so the spec records it in "Pi's lists are covered with documented differences".

Alternatives considered:

- **Pi's pattern only.** Rejected: it leaves `anthropic-messages` with a top-level body and `pi-messages` with a nested body retrying up to `maxRetries`.
- **Matching a bare `1308`.** Rejected: any number in any text could match it. It also would not catch the `anthropic-messages` form, which has no number.
- **A broader `已达到`.** Rejected: it only means "reached", and could describe a transient limit such as concurrency.
- **Requiring a provider id.** Rejected: gateways relay this body under any provider id.

Zhipu's public error-code table (https://docs.bigmodel.cn/cn/faq/api-code, read 2026-11-04) confirms the choice. `使用上限` appears only in hard limits: 1308, 1310, and 1316-1321, all of which reset after hours or days. The transient 429s do not carry it: 1302 reads `您的账户已达到速率限制，请您控制请求频率` and 1305 reads `该模型当前访问量过大，请您稍后再试`. So the wording also stops the other hard limits, which Pi's pattern does not list. Codes 1309, 1311, 1313, 1314, and 1315, also sent as HTTP 429 without that wording, stay `rate_limit`; they are outside this change.

### D3. Do not parse the reset time

`您的限额将在 2026-10-29 02:54:39 重置` carries no time zone. Guessing one could shift the wait by many hours, and the windows are hours long, so most waits would exceed `maxRetryAfterMs` anyway. The failure stops without a hint, the same as other quota errors without a reset time.

Alternative considered: assume UTC+8. Rejected: it adds a provider-specific parser for a rare benefit, and it is wrong for anyone relaying a different zone.

### D4. Keep the `context.?window.?exceeded` rule

Pi 1.5's new pattern does not make it redundant. A bare `litellm.ContextWindowExceededError` and `context_window_exceeded` still give `isContextOverflow` false, so this rule alone classifies them. The prose form now reaches `context_overflow` through Pi's patterns first, and Pi compacts and re-sends it. Only the comment changes, to say this.

Alternative considered: removing the rule as covered. Rejected: `500 litellm.ContextWindowExceededError` would become `server_error` and be retried.

### D5. Documentation

- The historical scenario "Gateway and stream failures added in Pi 1.4" stays as it is: the retryable list did not change from 1.4 to 1.5, and the title is true history. So do the notes at `src/vocabulary.ts:116` and `:134`, and "since Pi 1.4" on the 413 pattern in the README.
- `Retry decision by category`'s "Quota wording" and `Provider vocabulary`'s "Subscription limits" hold parallel lists. `align-with-pi-1-4` updated both when it added the workplace code, so this change does the same.
- The Codex comment moves to `openai-codex-responses.js:1245-1257`: `let friendlyMessage;` to the message's assignment, the same span as the old `1250-1262` on Pi 1.4.
- The main spec changes only through this delta, when the change is archived.

### D6. Tests

New rows in the `ROWS` table of `test/classification.test.ts`, which already drives a real Pi session with `maxRetries: 0`: a stop reads `not retrying`, a retry reads `giving up after 0 retries`, so a row checks both category and decision. `tasks.md` lists the rows and the expected results, measured by running these texts through that session setup on the current code and on a copy with the rule.

- **Each half of the rule has rows only it can satisfy.** Rows that carry code 1308 with the message `x` pass only through the code half. The `anthropic-messages` and `pi-messages` renderings pass only through `使用上限`. Removing either half on a copy made exactly those rows fail, so a rule broken on one side cannot hide behind the other.
- **The numeric form comes from Pi's pattern.** `"?` accepts it, but no response has shown it. The code-only numeric row is what guards that half of the pattern, and its source label says the form was not observed. The nested numeric row is a probe variant: it also contains `使用上限`, so it passes without the code half.
- **Rows that fail before the fix:** everything matching the rule. **Guards that pass before and after:** `13080`, which catches a lost digit boundary; `1302`, which catches a rule widened to other `130x` codes; and the three overflow rows below.
- **D4 had no test.** `test/` never mentions `ContextWindowExceeded` or `context_window_exceeded`, so new rows pin the two paths. Their expected text extends the row's `category` with the evidence (`context_overflow: ContextWindowExceeded`, `context_overflow: Pi's overflow patterns`). The row's matcher already treats that field as a regular expression prefix of the notice, so the `Row` shape does not change. Category alone could not tell the paths apart: the prose text also matches the `context.?window.?exceeded` rule. Removing that rule on a copy made the bare class name and the underscore form fail, and left the prose row passing through Pi's pattern.

### D7. Keep Pi's pattern as it is, without a closing quote

The rule does not use `"?1308"?`. Keeping Pi's pattern unchanged makes the two easy to compare when Pi's list is next checked. The cost is display only: where a reason names the matched evidence (an accepted hint, or a user pattern), it reads `quota: "code":"1308; provider asked to wait 7s (header retry-after)`, without the closing quote. The hint-less reason is a fixed string and is unaffected, and matching does not change.

Alternative considered: `"?1308"?(?![0-9])`. Rejected: a tidier evidence string does not justify a pattern that differs from Pi's without matching anything more.

## Risks / Trade-offs

- [Another provider's message, or an echoed prompt, contains `使用上限` on a transient failure] → It stops as `quota` instead of being retried, the same exposure as `billing` or `usage limit`. `patterns.retryable` overrides it, and the reason names the quota limit.
- [Another provider uses `"code":1308` for something else] → Same exposure as Pi's own pattern, with the same override.
- [The limit resets soon after the stop] → The user re-sends by hand. The message states the reset time, and the notification carries the reason. pi-retry cannot wait for it without D3's guess.
- [Pi's built-in retry is on] → Pi still retries the two renderings without `"code"` first, up to its own limit; pi-retry then stops. The README already asks users to turn Pi's retry off.
- [Zhipu changes its wording] → A rendering without the code and without `使用上限` falls back to `rate_limit` and is retried until `maxRetries`, which is today's behavior.

## Open Questions

1. **Does a real 1308 response carry a short `retry-after`?** Not verified: #11537 gives no headers, and the `retry-after: 7` in this change's probes came from the local test server. If one does, adapters that deliver error headers would retry after it under the existing quota contract, and "stops" would hold only for the hint-less path. This affects the wording about stopping on that path, and does not change the design.
