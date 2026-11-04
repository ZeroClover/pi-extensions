# Proposal

## Why

Zhipu/Z.ai sends most account and plan failures as HTTP 429 with a business code in the body. Only 1308 is on Pi's non-retryable list and in pi-retry's vocabulary, so the rest read as `rate_limit` and retry until `maxRetries` runs out, although no retry can succeed before someone renews a plan, tops up an account or changes an API key. Running both official code tables through a real Pi session found 65 of 274 renderings wrong, all of them for 13 codes. 1310 and 1316-1321 already stop when their wording is present; only their code-only forms, and 1310's English wording, are retried.

## What Changes

- **`quota` for account and plan limits**: 1113 (arrears), 1309 (plan expired), 1310 (weekly or monthly limit), 1313 (fair-use restriction), 1314 (enterprise plan expired) and 1316-1321 (limits with no extra usage available). Without an accepted retry hint they stop with the existing reason. An accepted hint is still honoured, and reset times in the text are not parsed.
- **`auth` for access restrictions**: 1311 (model outside the plan) and 1315 (wrong API key type). They stop whatever hint is present, because waiting cannot fix them.
- **Code and wording are both matched**, in Chinese and in English, because Pi's Anthropic adapter drops the code from the body #11537 reports, so a failure stops whether the error text keeps the code or not.
- **Documentation and regression rows**: the README's `quota` and `auth` rows, and end-to-end rows confirmed to fail before the fix, plus guards for what must not change.

Out of scope:

- Codes already decided correctly, including 1000-1005, 1200-1234, 1302 and 1305.
- 1261 `Prompt 超长`. It already stops. Compaction depends on Pi's overflow patterns, not on pi-retry's category (design D5).
- Other providers' codes, `domains:[null]`, provider-level retries, and Pi's own behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `error-classification`:
  - `Retry decision by category` lists the Zhipu/Z.ai codes and wording among the quota wording.
  - `Provider vocabulary` gains Zhipu/Z.ai scenarios for account and plan limits, a limit with an accepted hint, access restrictions, and codes that are not limits, and records the difference from Pi's decision.

## Impact

- **Source files**: `packages/pi-retry/src/vocabulary.ts`. The 1308 row is replaced by a quota code row and a quota wording row, and the auth group gains two rows. `src/classify.ts` does not change.
- **Documentation**: `packages/pi-retry/README.md`, the `quota` and `auth` rows.
- **Tests**: `packages/pi-retry/test/classification.test.ts`.
- **Release**: `src/` and `README.md` are published content, so this needs a `patch` intent for `@zeroclover/pi-retry`.
- **Unchanged**: configuration keys, commands, notification strings and session-record shapes.
