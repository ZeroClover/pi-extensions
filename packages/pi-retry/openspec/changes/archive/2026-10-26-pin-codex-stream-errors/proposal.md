# Proposal

## Why

The review of `align-with-pi-1-4` asked whether a Codex limit that arrives as a stream `error` event is handled like the HTTP 429 form (deepseek-Q1, issue I-13). It is handled correctly today, but no spec, test, or README line says so. A later vocabulary change could break it without any check failing.

The facts, checked against Pi 1.4.0 and the Codex CLI (`openai/codex` at `970111f`):

- The Codex backend relays an HTTP error inside a stream as `{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":…},"headers":{…}}` (`codex-rs/codex-api/src/endpoint/responses_websocket.rs:1123-1137`), or as `{"type":"error","status":429,"error":{"code":"rate_limit_exceeded"},…}` (`:1183-1188`).
- Pi's `mapCodexEvents` turns the event into `Codex error: <error.message, else error.code>` and drops `status`, `resets_at` and `headers` (`openai-codex-responses.js:531-559`). It attaches no diagnostic. This holds on both transports.
- pi-retry therefore reads `Codex error: The usage limit has been reached` as `quota` without a hint, and does not retry it. It reads `Codex error: rate_limit_exceeded` as `rate_limit`, and retries it.
- These match the Codex CLI's own decisions: `usage_limit_reached` is not retryable and `rate_limit_exceeded` is (`codex-rs/codex-api/src/api_bridge_tests.rs:86-88`). Unlike the HTTP form (design D7 of `align-with-pi-1-4`), the stream form keeps the two cases apart.

## What Changes

- Pin the current classification of the two stream forms with rows in the end-to-end classification table. Behavior does not change.
- Add a requirement for Codex stream error events to the `error-classification` spec.
- README:
  - Name the stream forms in the error-category table.
  - Note that Pi drops `resets_at` on this path, so a usage limit delivered in a stream always stops, even when it resets soon.
- Out of scope: recovering `resets_at` from the stream event. Pi does not pass it to extensions; that would take a Pi change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `error-classification`: adds the requirement "Codex stream error events". It is a new requirement rather than a scenario under "Provider vocabulary" because the pending change `align-with-pi-1-4` modifies that requirement.

## Impact

- **Tests**: `packages/pi-retry/test/classification.test.ts` gains rows. No source change is expected. If a row fails, the behavior is not what this proposal describes; stop and revise the plan.
- **Documentation**: `packages/pi-retry/README.md`.
- **Release**: `README.md` is published content, so this needs a `patch` intent for `@zeroclover/pi-retry` (documentation only).
- **Ordering**: archive `align-with-pi-1-4` first. This change's README edits sit next to text that change introduces, and its spec delta assumes that change's Codex scenario is in the main spec.
