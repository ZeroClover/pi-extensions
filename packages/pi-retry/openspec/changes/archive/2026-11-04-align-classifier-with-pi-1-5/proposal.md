# Proposal

## Why

Pi 1.5.0 added Zhipu/Z.ai's code 1308, a plan usage limit sent as HTTP 429 that resets after hours, to its non-retryable list (#11537). pi-retry has no matching entry, although its spec requires it to cover Pi's lists. A 1308 in Chinese is therefore `rate_limit` and retried: with Pi's retry off and `maxRetries: 2`, one such failure costs 3 requests, none of which can succeed. Pi's pattern alone would not be enough: Pi's `anthropic-messages` adapter renders the body reported in #11537 without its `"code"` field.

Pi 1.5 also recognises LiteLLM's prose `Context Window exceeded` as context overflow, and the Codex adapter's lines moved. The README, the spec and the source notes still describe Pi 1.4.

## What Changes

- **Zhipu/Z.ai 1308 is `quota`** (owner's decision): one new quota rule matches `"code":"1308"`, `"code":1308` and the wording `使用上限`. `使用上限` goes beyond Pi's list and is what catches the renderings without the code. As with every `quota` failure, an accepted `retry-after` hint is still honoured. Without one the failure stops with the existing reason `quota or billing limit without a reset time`. The reset time in the message is not parsed, because it carries no time zone.
- **Documentation follows Pi 1.5**: the README's quota and `context_overflow` rows, the spec's "checked against" statements and its differences from Pi's decision, and the source notes in `src/vocabulary.ts`, including the Codex line reference.
- **Regression scenarios**: new rows in the end-to-end classification table, confirmed to fail before the fix, plus guards for `13080`, `1302`, and the two context-overflow paths, which had no test.

Out of scope:

- Control flow and the header gate, which behave as they did on Pi 1.4.
- Parsing the reset time.
- Adapter-level re-sends under `retry.provider.maxRetries`, which are Pi's behavior.
- Pi 1.5 changes that do not affect pi-retry.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `error-classification`:
  - `Retry decision by category` lists the Zhipu/Z.ai wording among the quota wording.
  - `Provider vocabulary` is checked against Pi 1.5. It gains the Zhipu/Z.ai wording and scenario, the difference from Pi on `使用上限`, the agreement with Pi on `"code":"1308"`, and Pi 1.5's handling of LiteLLM's prose overflow.

## Impact

- **Source files**: `packages/pi-retry/src/vocabulary.ts` gets one rule and three corrected comments. `src/classify.ts` does not change.
- **Documentation**: `packages/pi-retry/README.md`, the `quota` and `context_overflow` rows.
- **Tests**: new rows in `packages/pi-retry/test/classification.test.ts`.
- **Release**: `src/` and `README.md` are published content, so this needs a `patch` intent for `@zeroclover/pi-retry`.
- **Delivery**: ships in the Pi 1.5 upgrade pull request (owner's decision).
- **Unchanged**: configuration keys, commands, notification strings and session-record shapes.
