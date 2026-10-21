# Proposal

## Why

The `error-classification` scenario "Pi's lists are covered with documented differences" describes a vocabulary test table run over every entry of Pi's built-in retry pattern lists. The repository-wide change `replace-unit-tests-with-e2e` deleted that table on purpose (its design D7 keeps one real text per category and per provider family), so the spec now names a test that does not exist, while the behavior it documents, where pi-retry decides differently from Pi, is still true and worth stating.

## What Changes

- Rewrite the scenario "Pi's lists are covered with documented differences" in the `Provider vocabulary` requirement in place, keeping its name, so that it states the behavior (pi-retry agrees with Pi's decision on Pi's list entries, except plain `quota exceeded` and bare status numbers; `429 insufficient_quota` agrees) without naming a test table.
- No behavior, code, or test changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `error-classification`: one scenario of `Provider vocabulary` is reworded from a test description into the behavior it guarantees.

## Impact

- `packages/pi-retry/openspec/specs/error-classification/spec.md` only. No `src/`, test, README, or published-content change, so no release decision is needed (`openspec/` is not in the package's published `files`).
