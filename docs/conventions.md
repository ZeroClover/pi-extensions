# Conventions

Rules for code in `packages/*/`. Where this document and Pi's own documentation disagree about Pi's API, Pi's documentation wins; fix this document.

## Language and formatting

- TypeScript, ES modules, Node 22+. No JavaScript source files.
- Biome formats and lints: tabs, line width 120, organized imports. Run `pnpm lint:fix` before committing; never hand-format against Biome.
- Relative imports carry the `.ts` extension. Node built-ins use the `node:` prefix.
- Use `import type` / `export type` for types (`verbatimModuleSyntax` is on).
- No `console.*` in extension code. Use `ctx.ui.notify()`, `ctx.ui.setStatus()`, tool results, or session entries. Tests may not log either; assert instead.
- Files are kebab-case. Types and classes are PascalCase, everything else camelCase. Tool names are snake_case (what the model sees), commands are kebab-case (what the user types).
- Package names are `@zeroclover/<directory name>`. Runtime identifiers (commands, settings files, session entry types, event channels) never derive from or change with the npm name.

## TypeScript strictness

`tsconfig.base.json` enables every strictness option TypeScript offers. What this means in practice:

| Option | Consequence for your code |
|---|---|
| `strict` | No implicit `any`, strict null checks, `unknown` in `catch`. Narrow before use. |
| `noUncheckedIndexedAccess` | `array[i]` and `record[key]` are `T \| undefined`. Check or use `.at()`/destructuring with defaults. |
| `exactOptionalPropertyTypes` | `prop?: T` does not accept an explicit `undefined`. Omit the property, or declare `prop?: T \| undefined` when a caller may pass undefined. |
| `noPropertyAccessFromIndexSignature` | Index-signature members need bracket access (`env["HOME"]`). Prefer typed shapes over index signatures. |
| `noImplicitReturns`, `noFallthroughCasesInSwitch` | Every code path returns; every `case` ends in `break`/`return`/`throw`. |
| `noUnusedLocals`, `noUnusedParameters` | Delete dead code. Prefix an intentionally unused parameter with `_`. |
| `noImplicitOverride` | Mark overriding methods with `override`. |

Forbidden: `any`, non-null assertions (`x!`), `@ts-ignore`, `@ts-expect-error`, `as unknown as T` casts, and weakening any shared config. If the Pi types make something impossible, read the declaration in `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` and model the code after a shipped example; do not cast around it.

`biome-ignore` is allowed only with a reason that names the rule and explains why the code is correct.

## Dependencies

- Host packages: `peerDependencies` with `"*"`. Never `dependencies`, never bundled.
- Prefer Node built-ins and the host packages (`@earendil-works/pi-tui` for rendering, `@earendil-works/pi-ai` for message types and `StringEnum`, `typebox` for schemas) before adding a dependency.
- Add a runtime dependency only when it removes real complexity. Pin a caret range, add it to the package (not the root), and run `pnpm install` so the lockfile updates.
- Dev tooling (TypeScript, Biome, Vitest, `@types/node`, and `yaml` for the release tooling) lives only at the root.

## Extension design

These follow from Pi's extension contract. Read `docs/pi-reference.md` for the sources.

### Entry and lifecycle

- The default export registers capabilities and returns. It must not start processes, timers, sockets, or watchers: Pi sometimes loads extensions without starting a session.
- Start long-lived resources in `session_start` or in the command or tool that needs them. Release them in an idempotent `session_shutdown` handler.
- Treat `ctx` as valid only for the duration of the handler that received it. Do not store a context and use it later.
- Guard terminal-only behavior with `ctx.mode === "tui"`; use `ctx.hasUI` for dialogs that RPC clients can also show. Tools and event handlers must work in print, JSON, and RPC modes.

### Tools

- Define tools with `defineTool()` and TypeBox schemas. Give every parameter a `description`. Use `StringEnum` from `@earendil-works/pi-ai` for enums and never `Type.Unknown()` (it serializes to `{}`, which some providers reject).
- Return `content` (model-facing) and `details` (rendering or state). Use `details: undefined` when there is nothing structured. Throw to produce an error result.
- Truncate large output and tell the model where to read the rest. Declare `outputSchema` and return `structuredContent` when the result is data.
- Use `executionMode: "sequential"` when tools share mutable in-memory state. Wrap read-modify-write of files with `withFileMutationQueue()`.
- Pass `ctx.signal` to nested work so cancellation propagates.

### State

| State | Storage |
|---|---|
| Follows the active branch, belongs to a tool | tool-result `details` |
| Durable, outside model context | `pi.appendEntry()` |
| Content the model should see | `pi.sendMessage()` |
| Outside a session | external file or service |

Rebuild in-memory state from `ctx.sessionManager.getBranch()` on `session_start`, not from every entry in the file.

### UI

- Prefer `ctx.ui.notify`, `select`, `confirm`, `input`, `setStatus`, `setWidget` over custom components.
- Custom components must measure width with `visibleWidth()`/`truncateToWidth()` from `@earendil-works/pi-tui`, use the supplied theme, and invalidate cached lines when state changes.

### Errors

- Fail loudly in development: throw with a message that says what was expected. Pi reports handler errors and continues.
- Never swallow an error silently. If an error is recoverable, surface it through `ctx.ui.notify(..., "warning")` or the tool result.

## Tests

Tests are end-to-end: they check what a user or a workflow can observe, through the same boundaries the code meets in production. `openspec/specs/change-verification` holds the requirements.

- Vitest, files under `packages/<name>/test/*.test.ts`; root tooling tests live under `tools/<name>/test/`. Package-specific fixtures (fake programs, stub tools, data tables, worker scripts) stay in the package's `test/`; only generic machinery belongs in `tools/e2e/`.
- An extension test starts a real Pi session with the package loaded from `packages/<name>/` through `startPi` from `tools/e2e/src/`, and drives it as a user would: a scripted provider answers the model's requests (its stream events are the only model double), a recording UI stands in for the terminal, and temporary executables on `PATH` stand in for programs outside the repository. Stub tools may stand in for the tools of third-party extensions the package adapts to.
- Assert only on what the session exposes: tool results, the requests the provider received, notifications, status text, session entries, event-bus payloads, and files the extension writes.
- Never import a package's `src/` at runtime. Type-only imports of payload types the package documents as public are allowed. Never fabricate Pi's extension events (the payloads Pi delivers to `pi.on` handlers) or `pi`/`ctx` objects; a behavior-neutral refactor of `src/` must not require a test change.
- Release tooling tests run `node tools/release/src/cli.ts` as a process in a temporary git repository whose release files come from real `pnpm change` and `pnpm version -r`; GitHub and the registry are replaced only at the process boundary.
- Name each `it(...)` after the user-visible failure it prevents, and cite the spec requirement it covers in a one-line comment. Do not add a test only to raise coverage or to restate a value the code computes.
- Time-dependent assertions use bands: rates within ±30% of the scripted rate, durations as lower bounds, upper bounds only where the behavior is "early" and then with a margin of at least 1 s. Fix a flaky test by widening its band or rewriting it, never by retrying.
- Tests need no network, credentials, or model calls. A check against an optional external tool is skipped, with the reason in its title, when the tool is absent.
- Every bug fix adds or extends an end-to-end test that fails without the fix and passes with it.
- A new scenario counts only after it was seen to fail against a deliberately broken extension (a temporary, uncommitted edit) and to pass on the real code.

## Documentation

- Each package has a `README.md` with: one-paragraph purpose, install/try commands (`pi install npm:@zeroclover/<name>` for published versions, the directory for checkouts), every tool, command, flag, and setting it registers, and configuration locations. Never state that a version is released before it is.
- Each package's `CHANGELOG.md` is generated by `pnpm version -r` from change intent summaries and reviewed by hand; its prose is the release notes. Write summaries for users, not from commit messages.
- The root `README.md` extension table lists every package with its description.
- Comments explain why, not what. No commented-out code, no change logs in comments.
