# Tasks

## 1. Precondition

- [x] 1.1 Confirm that `align-with-pi-1-4` is archived. From `packages/pi-retry/`, `openspec list --json` must not list it, and `openspec/specs/error-classification/spec.md` must contain the scenario "Codex usage limit without a reset time". If it is not archived, stop and archive it first (proposal "Impact", Ordering).

## 2. Pin the classification (error-classification: Codex stream error events)

- [x] 2.1 Add two rows to the `ROWS` table in `packages/pi-retry/test/classification.test.ts`, next to the other Codex rows, each with a `source` that names Pi's Codex stream `error` event:
  - `Codex error: The usage limit has been reached` as `quota` / not retrying.
  - `Codex error: rate_limit_exceeded` as `rate_limit` / retried.

  Verify:
  - `pnpm vitest run packages/pi-retry` passes on the current code. No source change is expected; if a row fails, stop and revise the plan.
  - Following `docs/conventions.md`, make sure each row fails against a deliberately broken extension. Remove the `usage.?limit` quota rule in `src/vocabulary.ts` temporarily and see the first row fail; make the `rate.?limit` rule unreachable temporarily and see the second row fail. Then revert both edits and confirm that `git diff packages/pi-retry/src` is empty.

## 3. Documentation

- [x] 3.1 Update `packages/pi-retry/README.md`:
  - In the "Error categories" table, add `Codex error: The usage limit has been reached` (a Codex usage limit relayed in the stream) to the `quota` row.
  - Under the table, add one sentence saying that a Codex error relayed in the stream reaches pi-retry as `Codex error: <message or code>`. Pi drops the event's status and reset time, so a usage limit there is never retried, even when it resets soon, while `rate_limit_exceeded` is retried with backoff.

  Verify that the sentence matches the two rows from 2.1, and that `rg -n "Codex error" packages/pi-retry/README.md` shows both places.

## 4. Release and verification

- [x] 4.1 Record the release decision from the repository root: `pnpm change --bump patch --summary "<user-facing summary: the README now explains how Codex errors relayed in the response stream are classified and why a usage limit there is not retried>" @zeroclover/pi-retry`. Verify with `pnpm change status`.
- [x] 4.2 From the repository root, run `pnpm check` and confirm it passes. From `packages/pi-retry/`, run `openspec validate pin-codex-stream-errors --strict` and confirm it passes. Report both commands as run.

## Workflow follow-up

- Archive the change, which syncs the new requirement into `packages/pi-retry/openspec/specs/error-classification/spec.md`.
- Commit as `test(pi-retry): pin classification of Codex stream errors`.
