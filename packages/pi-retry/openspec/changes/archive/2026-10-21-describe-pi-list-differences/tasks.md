# Tasks

## 1. Spec

- [x] 1.1 Write the `error-classification` delta that rewrites the body of the scenario "Pi's lists are covered with documented differences" (the name stays), leaving every other scenario of `Provider vocabulary` unchanged. Verify with `openspec validate describe-pi-list-differences --strict` from `packages/pi-retry/`.
- [x] 1.2 Confirm that no spec, README, or doc in the repository still refers to a vocabulary test table: `rg -n "vocabulary test table" packages docs` returns nothing after the archive sync, and `pnpm check` passes.

## Workflow follow-up

- Archive the change, syncing the delta into `packages/pi-retry/openspec/specs/`.
- Commit as `docs(pi-retry): describe differences from Pi's retry lists as behavior`.
