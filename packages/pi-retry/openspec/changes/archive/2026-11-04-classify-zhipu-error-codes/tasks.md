# Tasks

## 1. Test rows

- [x] 1.1 In `packages/pi-retry/test/classification.test.ts`, add a `ZHIPU_ROWS: Row[]` table above `ROWS`, with a comment naming the two official tables, and spread it into `ROWS` after the existing Pi 1.5 rows. Generate repeated code-only rows with `.map` where that reads better. Start with these guards:

  | Source | Text | Decision | Category |
  |---|---|---|---|
  | 1316 English reset time carries no time zone: no hint | `429 Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-11-05 02:54:39.` | stopped | `quota` |
  | code 1302 is transient | `429 {"code":"1302","message":"x"}` | retried | `rate_limit` |
  | code 1305 is transient | `429 {"code":"1305","message":"x"}` | retried | `rate_limit` |
  | code 1312 is on neither table | `429 {"code":"1312","message":"x"}` | retried | `rate_limit` |
  | code 1322 is on neither table | `429 {"code":"1322","message":"x"}` | retried | `rate_limit` |
  | a longer code is not 1309 | `429 {"code":"13090","message":"x"}` | retried | `rate_limit` |
  | a longer code is not 1113 | `429 {"code":"11130","message":"x"}` | retried | `rate_limit` |
  | a longer code is not 1311 | `429 {"code":"13110","message":"x"}` | retried | `rate_limit` |
  | a longer code is not 1315 | `429 {"code":"13150","message":"x"}` | retried | `rate_limit` |
  | 1302 wording | `429 您的账户已达到速率限制，请您控制请求频率` | retried | `rate_limit` |
  | 1305 wording | `429 该模型当前访问量过大，请您稍后再试` | retried | `rate_limit` |
  | 1302 English wording | `429 Rate limit reached for requests` | retried | `rate_limit` |
  | 1305 English wording | `429 The service may be temporarily overloaded, please try again later` | retried | `rate_limit` |
  | 1200 | `500 {"error":{"code":"1200","message":"API 调用失败"}}` | retried | `server_error` |
  | 1230 | `500 {"error":{"code":"1230","message":"API 调用流程出错"}}` | retried | `server_error` |
  | 1234 | `500 {"error":{"code":"1234","message":"网络错误，错误id：20261104abc，请联系客服"}}` | retried | `server_error` |
  | 1261 table wording: no Pi overflow pattern matches it | `400 Prompt 超长` | stopped | `invalid_request: HTTP 400` |
  | 1261 wording of Pi's CN endpoint pattern | `400 Prompt exceeds max length` | stopped | `context_overflow: Pi's overflow patterns` |
  | 1261 English wording: Pi's overflow pattern | `400 Prompt too long` | stopped | `context_overflow: Pi's overflow patterns` |
  | 1001 | `401 {"error":{"code":"1001","message":"Header 中未收到 Authentication 参数，无法进行身份验证"}}` | stopped | `auth: HTTP 401` |
  | 1211 | `400 {"error":{"code":"1211","message":"模型不存在，请检查模型代码"}}` | stopped | `invalid_request: HTTP 400` |
  | 1301 | `400 {"error":{"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合"}}` | stopped | `invalid_request: HTTP 400` |

  Verify before touching `src/`: `pnpm vitest run packages/pi-retry/test/classification.test.ts` passes, since these describe today's behavior.
- [x] 1.2 Add these rows to `ZHIPU_ROWS`:

  | Source | Text | Decision | Category | Today |
  |---|---|---|---|---|
  | code 1113 only | `429 {"code":"1113","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1309 only | `429 {"code":"1309","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1310 only | `429 {"code":"1310","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1313 only | `429 {"code":"1313","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1314 only | `429 {"code":"1314","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1316 only | `429 {"code":"1316","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1317 only | `429 {"code":"1317","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1318 only | `429 {"code":"1318","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1319 only | `429 {"code":"1319","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1320 only | `429 {"code":"1320","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1321 only | `429 {"code":"1321","message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | code 1311 only | `429 {"code":"1311","message":"x"}` | stopped | `auth` | retried, `rate_limit` |
  | code 1315 only | `429 {"code":"1315","message":"x"}` | stopped | `auth` | retried, `rate_limit` |
  | numeric quota code, form from Pi's pattern | `429 {"code":1309,"message":"x"}` | stopped | `quota` | retried, `rate_limit` |
  | numeric auth code, form from Pi's pattern | `429 {"code":1311,"message":"x"}` | stopped | `auth` | retried, `rate_limit` |
  | documented body, quota | `429 {"error":{"code":"1309","message":"您的 GLM Coding Plan 套餐已到期，暂无法使用，前往官方续订后即可恢复 https://bigmodel.cn/claude-code"}}` | stopped | `quota` | retried, `rate_limit` |
  | documented body, auth | `429 {"error":{"code":"1311","message":"当前订阅套餐暂未开放glm-x权限"}}` | stopped | `auth` | retried, `rate_limit` |
  | 1113 wording without the code | `429 您的账户已欠费，请充值后重试` | stopped | `quota` | retried, `rate_limit` |
  | 1309 wording without the code | `429 您的 GLM Coding Plan 套餐已到期，暂无法使用，前往官方续订后即可恢复 https://bigmodel.cn/claude-code` | stopped | `quota` | retried, `rate_limit` |
  | 1313 wording without the code | `429 您的账户当前使用模式不符合公平使用策略，请求频率已受到限制。如需恢复请前往个人中心-编程套餐总览-顶部申请解除限制` | stopped | `quota` | retried, `rate_limit` |
  | 1314 wording without the code | `429 您的企业套餐已失效，请联系企业管理员。` | stopped | `quota` | retried, `rate_limit` |
  | 1311 wording without the code | `429 当前订阅套餐暂未开放glm-x权限` | stopped | `auth` | retried, `rate_limit` |
  | 1315 wording without the code | `429 该 API Key 仅限企业编程套餐场景使用，请到官网更换对应产品类型的 API Key` | stopped | `auth` | retried, `rate_limit` |
  | 1113 English wording without the code | `429 Insufficient balance or no resource package. Please recharge.` | stopped | `quota` | retried, `rate_limit` |
  | 1309 English wording without the code | `429 Your GLM Coding Plan package has expired and is temporarily unavailable. You can resume using it after renewing the subscription on the official website.` | stopped | `quota` | retried, `rate_limit` |
  | 1310 English wording without the code | `429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-05 02:54:39` | stopped | `quota` | retried, `rate_limit` |
  | 1313 English wording without the code | `429 Your account's current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited. To restore access, please submit a request.` | stopped | `quota` | retried, `rate_limit` |
  | 1314 English wording without the code | `429 Your enterprise package has expired. Please contact your enterprise administrator.` | stopped | `quota` | retried, `rate_limit` |
  | 1311 English wording without the code | `429 Your current subscription plan does not yet include access to glm-x` | stopped | `auth` | retried, `rate_limit` |
  | 1315 English wording without the code | `429 This API Key is limited to enterprise coding package scenarios. Please go to the official website to replace the API Key of the corresponding product type.` | stopped | `auth` | retried, `rate_limit` |
  | 1113 wording with the code in parentheses (pi-messages adapter) | `429 Too Many Requests: 您的账户已欠费，请充值后重试 (1113)` | stopped | `quota` | retried, `rate_limit` |
  | quota code: the hint is read, not its schedule (maxRetries 0) | `429 {"code":"1309","message":"Try again in 2s"}` | retried | `quota: "code":"1309; provider asked to wait 2s` | retried, `rate_limit` |
  | auth code ignores a hint | `429 {"code":"1311","message":"Try again in 2s"}` | stopped | `auth` | retried, `rate_limit` |

  The quota hint row's `category` includes the hint as the notice reports it. With `maxRetries: 0` the wait never runs, so the row says nothing about scheduling; `test/hints.test.ts:36-37` covers that. Say so in a comment beside the row.

  Verify before touching `src/`: the same command fails with exactly these 33 rows differing, as in the "Today" column, and no guard from 1.1 appears in the failure diff. Record the result for the final report.

## 2. Rules (error-classification: Provider vocabulary, Retry decision by category)

- [x] 2.1 In the quota group of `packages/pi-retry/src/vocabulary.ts`, replace the 1308 row with the quota code row and the quota wording row from design D1, and name the two official tables and the new codes in the group's source comment. Verify that the 1.2 rows with category `quota` and every earlier row pass, and that the rows with category `auth` still fail.
- [x] 2.2 Add the auth code row and the auth wording row from design D1 to the auth group of `src/vocabulary.ts`, with a source comment saying that these are 429s about what a credential may do. Verify that `pnpm vitest run packages/pi-retry` passes with no existing row edited, and that `git diff packages/pi-retry/src/classify.ts` is empty.
- [x] 2.3 In `packages/pi-retry/README.md`, change the `quota` row's Zhipu/Z.ai entry to list codes `1113`, `1308`-`1310`, `1313`, `1314`, `1316`-`1321` and the wording from design D4, and add codes `1311`, `1315` and their wording to the `auth` row. Verify that each row names every alternative of the rules in 2.1 and 2.2.

## 3. Mutation checks

- [x] 3.1 Make each of these temporary edits to `src/vocabulary.ts` in turn, run `pnpm vitest run packages/pi-retry/test/classification.test.ts`, record which rows fail, and restore the file:

  | Edit | Rows that must fail (measured on a copy) |
  |---|---|
  | remove the quota code row | the 11 code-only quota rows, the numeric quota row, the quota hint row, and the existing 1308 code-only and numeric code-only rows |
  | remove the quota wording row | the 9 rows with quota wording and no code in both languages, the 1113 `pi-messages` row, and the existing 1308 Anthropic and `pi-messages` rows |
  | remove the auth code row | the code-only and numeric auth rows, and the row where a hint is ignored |
  | remove the auth wording row | the 4 rows with auth wording and no code |
  | widen the quota code row's alternation to `1113` and `13[0-9]{2}`, keeping 1113 | `1302`, `1305`, `1312`, `1322`, the `1301` guard, and the existing `1302` and Mistral `1300` rows |
  | drop `(?![0-9])` from the quota code row | `13090`, `11130`, and the existing `13080` row |
  | drop `(?![0-9])` from the auth code row | `13110`, `13150` |

  Verify after the last restore that `git diff packages/pi-retry/src/vocabulary.ts` equals the 2.1 and 2.2 change. Correct the plan if a mutation fails different rows than listed.

## 4. Release and verification

- [x] 4.1 Record the release decision from the repository root: `pnpm change --bump patch --summary "Zhipu/Z.ai account, plan and API key errors (codes 1113, 1309-1311, 1313-1321) are no longer retried as rate limits: plan and balance limits count as quota and stop without an accepted retry hint, and model or API key restrictions (1311, 1315) count as auth and stop." @zeroclover/pi-retry`. Verify with `pnpm change status`.
- [x] 4.2 Run `pnpm check` from the repository root and make sure it passes. Run `openspec validate classify-zhipu-error-codes --strict` from `packages/pi-retry/` and make sure it passes. Report both as run. Also report that no request reached a real Zhipu/Z.ai endpoint, since these failures need a failing account: the scenarios use the scripted provider, with texts from the official tables and renderings captured from Pi's adapters.

## Workflow follow-up

- Archive the change after review, syncing the delta into `packages/pi-retry/openspec/specs/error-classification/spec.md`, and confirm that the main spec has the four new scenarios.
- Commit as `fix(pi-retry): classify Zhipu/Z.ai error codes`, when a commit is requested.
- Push the branch and open a pull request to `master`, when requested.
