# Design

## Context

The scenario was written while `packages/pi-retry/test/classify.test.ts` held a row for every entry of Pi's two built-in lists and asserted agreement with `isRetryableAssistantError` row by row. That file was deleted by the root change `replace-unit-tests-with-e2e`; its end-to-end classification scenario R3 keeps one text per category and provider family, including Google's per-minute quota and the documented precedence traps.

## Decisions

- **State the guarantee, not the test.** Specs describe observable behavior (`openspec` spec instructions). The differences from Pi are a user-visible contract (a Google per-minute quota is retried here and not in Pi; a number outside a status position is not a status), so they stay, as a WHEN/THEN about decisions.
- **No new test.** The two differences are already covered by existing scenarios and tests: "Google per-minute quota" (and R3's Google per-minute row), "HTTP status recognition" (status positions), and "Billing quota"/`insufficient_quota` (R3 rows). Re-adding an exhaustive table would restate Pi's list, which the root design rejects (D7).

## Risks / Trade-offs

- [The claim "agrees with Pi on every other entry" is no longer checked entry by entry] → Accepted as in the root change's D7; a misclassified text gets an end-to-end row under the bug-fix rule.
