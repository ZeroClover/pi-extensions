# Design

## Context

See proposal.md, "Why". The sources are Zhipu's table (`https://docs.bigmodel.cn/cn/faq/api-code`) and Z.ai's English table (`https://docs.z.ai/api-reference/api-code`), both read on 2026-11-04. They list the same codes and statuses.

Every code was run in both languages through a real Pi session with the scripted provider, using the session options of `ROWS` in `test/classification.test.ts`. Each ran in the renderings that matter:

| Rendering | Form | Source |
|---|---|---|
| documented shape | `429 {"error":{"code":"1309","message":"…"}}` | both tables; Pi's Anthropic adapter keeps it |
| OpenAI Completions | `429: {"code":"1309","message":"…"}` | Pi's adapter, for either body shape |
| Anthropic, no code | `429 <message>` | Pi's adapter, for the top-level body #11537 reports |
| code only | `429: {"code":"1309","message":"x"}` | the code half of a rule on its own |

Results on the current code, where `R` is retried and `S` is stopped:

| Code | Status | Now | Wrong? |
|---|---|---|---|
| 1000, 1001, 1003, 1005, 1220 | 401, 403 | `auth` S | no |
| 1210-1215, 1221, 1222, 1301 | 400 | `invalid_request` S | no |
| no code, 1200, 1230, 1234 | 500 | `server_error` R (English 1234 with its wording: `transport` R) | no |
| 1302, 1305 | 429 | `rate_limit` R | no |
| 1308 | 429 | `quota` S | no |
| 1261 | 400 | Table wording `Prompt 超长`: `invalid_request` S. `Prompt too long` and `Prompt exceeds max length`: `context_overflow` S through Pi's patterns | see D5 |
| 1113, 1309, 1313, 1314 | 429 | `rate_limit` R, every rendering | yes |
| 1311, 1315 | 429 | `rate_limit` R, every rendering | yes |
| 1310 | 429 | Chinese with wording: `quota` S. English, and code only: `rate_limit` R | yes, in part |
| 1316-1321 | 429 | With wording: `quota` S. Code only: `rate_limit` R | yes, code only |

Pi 1.5's `isRetryableAssistantError` is true for all of the wrong ones. Only 1308 is on its list, so this change goes beyond Pi's list on purpose.

`classify` already gives deterministic wording priority over a 429 and stops `quota` without a hint, so only the vocabulary changes.

## Goals / Non-Goals

**Goals:**
- A code on the two tables whose failure cannot succeed on a retry stops, whether the error text keeps the code or not.
- Codes that are transient, or already decided correctly, do not change.

**Non-Goals:**
- Relabelling failures whose decision is already right (D5, D6).
- Provider-gating the rules (D1).
- Parsing reset times. English `Resets at 2026-11-05 02:54:39.` has no `T` or zone, so the existing `resets at` hint does not read it. A row pins this.

## Decisions

### D1. Literal rows: one code row and one wording row per category

The 1308 row is replaced rather than stacked:

```ts
// auth group
{ pattern: /"code"\s*:\s*"?(?:1311|1315)(?![0-9])/i, category: "auth" },
{ pattern: /订阅套餐暂未开放|仅限企业编程套餐|subscription plan does not yet include access|API Key is limited to enterprise coding package/i, category: "auth" },

// quota group
{ pattern: /"code"\s*:\s*"?(?:1113|1308|1309|1310|1313|1314|1316|1317|1318|1319|1320|1321)(?![0-9])/i, category: "quota" },
{ pattern: /使用上限|账户已欠费|套餐已到期|套餐已失效|公平使用策略|insufficient balance|(?:plan|enterprise) package has expired|Weekly\/Monthly Limit Exhausted|Fair Usage Policy/i, category: "quota" },
```

The code half keeps the shape of Pi's 1308 pattern (`"?` and no closing quote, as `align-classifier-with-pi-1-5` decided). `(?![0-9])` keeps `13090` and `11130` out, and an explicit list keeps 1302, 1305 and the unlisted 1312 and 1322 out.

The code rows have the same limit as the 1308 row today: the parenthesised `(1309)` that Pi's `pi-messages` adapter writes, and a bare code that exists only in a diagnostic, do not match. Every message in the two tables is already covered by a wording row, so this needs no further pattern.

Trial on a copy: 65 of the 274 measured renderings change, all of them for the 13 codes above. Nothing else moves.

Alternatives considered:

- **A table of codes in a constant, with a built regular expression.** Rejected: the file is literal rows with source notes, and four rows stay readable.
- **Range shorthand such as `131[6-9]`.** Rejected: an explicit list can be compared with the tables at a glance.
- **Requiring a Zhipu provider id.** Rejected for the reason #27 gave: gateways relay these bodies under any provider id.

### D2. Account and plan limits are `quota`

1113, 1309 and 1314 need a payment or a renewal. 1310 and 1316-1321 are the same kind of limit as 1308, so the code-only form joins it.

1313 is a fair-use restriction that says requests are limited and that access returns only after an application. The credentials are valid, so it is not `auth`, and it does not clear on its own, so it is not `rate_limit`. `quota` gives the wanted treatment: stop without a hint, honour one the provider sends.

### D3. Access restrictions are `auth`

1311 says the plan does not include a model. 1315 says the key is the wrong product type. Neither is a matter of amount, and both are about what a credential may do, which is `permission_error` and `PERMISSION_DENIED`'s family.

Why not the others:

- **`invalid_request`.** `categorise` discards `invalid_request` wording on a 429 (OpenAI's 429 bodies carry `invalid_request_error`), so these would stay `rate_limit` unless precedence changed. That changes more than this fix needs.
- **`quota`.** It honours a hint, and waiting cannot fix either code. Measured with `Try again in 2s`: 1309 is retried in 2 s as `quota`, 1311 stops as `auth`.
- **`not_found` for 1311.** The vocabulary has a precedent for access wording there: OpenAI's `does not exist or you do not have access` is `not_found`. That message is a 404 that cannot say which of the two applies. 1311 is a 429 that names a model id that exists, and the boundary it reports is the plan's, so looking the model up again or under another spelling is not the fix.

### D4. Wording in both languages

Z.ai documents English messages for the same codes, and Pi's Anthropic adapter can drop the code, so without English wording `429 Weekly/Monthly Limit Exhausted…` and the like stay `rate_limit`. Each phrase is taken from a table and names the condition itself:

| Code | Chinese | English |
|---|---|---|
| 1113 | `账户已欠费` | `insufficient balance` |
| 1309 | `套餐已到期` | `plan package has expired` |
| 1310 | `使用上限` (existing) | `Weekly/Monthly Limit Exhausted` |
| 1313 | `公平使用策略` | `Fair Usage Policy` |
| 1314 | `套餐已失效` | `enterprise package has expired` |
| 1311 | `订阅套餐暂未开放` | `subscription plan does not yet include access` |
| 1315 | `仅限企业编程套餐` | `API Key is limited to enterprise coding package` |

The table says `Insufficient balance or no resource package`; the shorter `insufficient balance` is used because other providers' wording for the same condition should also be `quota`. `已达到` and similar broad words are avoided. 1309's English also contains `temporarily unavailable`, a transient phrase, which the deterministic row beats.

### D5. 1261 stays `invalid_request`

Pi 1.5's `utils/overflow.js` has a pattern for this code on the CN endpoint: `/prompt exceeds max length/i`, with the comment `{"code":"1261","message":"Prompt exceeds max length"}`. It has none for the official table's wording, `Prompt 超长`. Measured with compaction on and earlier turns in the session:

| Text | Current code | With a trial `context_overflow` rule |
|---|---|---|
| `400 Prompt 超长`, and the documented shape | 1 request, no compaction, `invalid_request: HTTP 400` | 1 request, no compaction, only the label differs |
| `400 Prompt exceeds max length`, and the documented shape | compaction through Pi, 4 requests, recovers | not run: Pi handles it first |
| `400 Prompt too long` | compaction through Pi, 4 requests, recovers | same |

So the table's wording already stops, and a `context_overflow` label would not trigger compaction, because compaction depends on Pi's `isContextOverflow`, not on pi-retry's category. The label would also make the README's "handled by Pi's compaction" untrue for this text. Guard rows pin all three texts.

### D6. Other imprecise labels stay

1211 (`模型不存在`) and 1301 (unsafe content) read `invalid_request`, where `not_found` and `content_policy` would be closer. They stop either way, so they are left alone like 1261.

### D7. Tests

Rows live in a `ZHIPU_ROWS` table spread into `ROWS`, so they share its session and its check of category and decision. `tasks.md` lists each row with its result, measured on the current code and on a copy with the rules: 33 rows fail today and 22 guards pass both before and after.

- Rows with the message `x` pass only through a code row. Rows without a code pass only through a wording row, so one half cannot hide a fault in the other.
- The numeric form follows Pi's pattern and has not been observed in a response. Its row says so.
- Guards use the evidence form of `category` (`invalid_request: HTTP 400`) where the path matters.
- The session has `maxRetries: 0`, so the wait never runs. The hint row asserts the hint as the notice reports it (`quota: "code":"1309; provider asked to wait 2s`), and nothing about scheduling. `test/hints.test.ts:36-37` covers the wait itself for a text hint.

## Risks / Trade-offs

- [Another provider or gateway uses one of these numbers as `"code"` for something else] → It stops instead of being retried. The exposure is wider than Pi's single code, and the existing Mistral `1300` row shows that 13xx codes do occur elsewhere, so the list names exact codes only. `patterns.retryable` overrides it.
- [Another provider's text contains one of the phrases on a transient failure, or an error echoes a prompt] → Same exposure as `billing`, with the same override. `insufficient balance` is the broadest phrase, and its meaning is the same anywhere.
- [An `auth` label on a 429 surprises someone reading the status] → The reason names the evidence, for example `auth: 订阅套餐暂未开放`.
- [1313 lifts sooner than expected] → The user re-sends by hand.
- [Zhipu changes its wording] → A rendering without the code falls back to `rate_limit` and retries, which is today's behavior.
- [Pi's built-in retry is on] → Pi still retries first, up to its limit, and pi-retry then stops. The README already asks users to turn it off.

## Open Questions

1. **Real responses for these codes.** The texts come from the official tables and Pi's adapters, not from failing accounts, so a live message may differ from the table. 1261 is a known case: the table says `Prompt 超长`, while Pi's comment records `Prompt exceeds max length` for the CN endpoint. This only affects how much the wording rows catch: the code rows still apply wherever the code survives, and a miss behaves as it does today.
