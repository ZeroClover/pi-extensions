# Workflow

## Plan with OpenSpec

Non-trivial work (a new extension, a new tool or command, a behavior change, a removal) is planned with OpenSpec before code is written. Trivial fixes (typos, a one-line bug with an obvious test) can skip it.

Two roots exist, and the CLI picks the nearest one above the working directory:

| Work | Working directory | Root |
|---|---|---|
| One package | `packages/<name>/` | `packages/<name>/openspec/` |
| Repository-wide (tooling, docs, conventions) | repository root | `openspec/` |

Always run `openspec` from the directory in the table; from the repository root, a package change would land in the wrong root. Check with `openspec context --json` when unsure: `root.path` must be the package directory for package work.

The workflow is the standard OpenSpec one, available as skills in `.agents/skills/` (`openspec-propose`, `openspec-apply-change`, `openspec-archive-change`, ...) and as `/opsx:*` commands in Claude Code:

1. Propose: creates `openspec/changes/<change>/` with `proposal.md`, spec deltas, `design.md`, `tasks.md`. Stop and let the user review.
2. Apply: implement the tasks, checking them off as they are verified.
3. Archive: merges spec deltas into `openspec/specs/` and moves the change to `changes/archive/`.

A package's `openspec/specs/` is the current description of what that extension does; keep it truthful when archiving.

## Create a new extension

1. Choose a name: `pi-<topic>`, lowercase, hyphenated. The directory and the package `name` match.
2. Create the package from the templates below. Replace `<name>` and the placeholder text.
3. Initialize the package's OpenSpec root and set its context:

   ```bash
   openspec init packages/<name> --tools none --no-animation
   ```

   `--tools none` keeps agent command and skill files at the repository root only; never generate harness files inside a package. Then fill `packages/<name>/openspec/config.yaml`:

   ```yaml
   schema: spec-driven

   context: |
     Scope: the pi-<name> extension in this directory only. Repository-wide
     concerns belong to the repository root's openspec/.
     Constraints: follow ../../AGENTS.md and ../../docs/conventions.md.
     Verification for every change: pnpm check from the repository root and
     the load smoke test in ../../docs/workflow.md.
   ```

4. Run `pnpm install` so the workspace knows the package.
5. Propose the first change from `packages/<name>/` (see above), then implement it in `src/`, following `docs/conventions.md`. Consult Pi's docs and the closest shipped example (`docs/pi-reference.md`) before using an API.
6. Verify (next section).
7. Write the package `README.md` and add a row to the table in the root `README.md`.
8. Archive the change, then commit: `feat(pi-<name>): <summary>`.

### `packages/<name>/package.json`

```json
{
	"name": "pi-<name>",
	"version": "0.1.0",
	"description": "<one sentence>",
	"type": "module",
	"keywords": ["pi-package", "pi-extension"],
	"files": ["src", "README.md"],
	"pi": {
		"extensions": ["./src/index.ts"]
	},
	"peerDependencies": {
		"@earendil-works/pi-coding-agent": "*"
	}
}
```

Add `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, or `typebox` to `peerDependencies` as the code imports them. Biome formats `package.json`; run `pnpm lint:fix` after editing it.

### `packages/<name>/src/index.ts`

```ts
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { greeting } from "./greeting.ts";

const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "Greet someone by name",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: greeting(params.name) }],
			details: undefined,
		};
	},
});

export default function (pi: ExtensionAPI): void {
	pi.registerTool(helloTool);
	pi.registerCommand("hello", {
		description: "Show a greeting",
		handler: async (name, ctx) => {
			ctx.ui.notify(greeting(name), "info");
		},
	});
}
```

### `packages/<name>/src/greeting.ts` and `test/greeting.test.ts`

```ts
export function greeting(name: string): string {
	return `Hello, ${name.trim() || "world"}!`;
}
```

```ts
import { describe, expect, it } from "vitest";
import { greeting } from "../src/greeting.ts";

describe("greeting", () => {
	it("greets by name", () => {
		expect(greeting("Pi")).toBe("Hello, Pi!");
	});
});
```

### `packages/<name>/README.md`

```markdown
# pi-<name>

<What it does and why, in one paragraph.>

## Install

pi -e ./packages/<name>                       # try for one session
pi install /absolute/path/to/packages/<name>  # install for the user

## Provides

| Kind | Name | Description |
|---|---|---|
| tool | `hello` | ... |
| command | `/hello` | ... |

## Configuration

<Settings, files, environment variables, or "None.">
```

## Verify

Every change ends with all of these, run from the repository root:

1. `pnpm check`: Biome, `tsc`, and Vitest must all pass with no warnings you introduced.
2. Load smoke test without a model call:

   ```bash
   printf '{"id":"1","type":"get_commands"}\n' | pi -ne -e ./packages/<name> --mode rpc
   ```

   Exit code 0 and the package's commands in the response mean the extension loaded. A load failure prints `Failed to load extension` and exits non-zero.
3. For behavior that needs a live session (tools the model calls, UI, events), run `pi -ne -e ./packages/<name>` interactively or with `--print` and exercise the feature. State in the final report exactly what was exercised.

A running Pi session keeps the extension code it loaded at startup. After editing `src/`, restart Pi (or `/reload`) before testing again.

## Change an existing extension

1. Read the package README, `openspec/specs/`, and `src/index.ts` first, then the modules you touch.
2. For non-trivial changes, propose from `packages/<name>/` and wait for review.
3. Make the change with its test. Keep the package's public surface (tool names, command names, settings) stable unless the change is the point.
4. Update the README when tools, commands, flags, or configuration change.
5. Verify, archive the change, then commit as `fix(pi-<name>): ...` or `feat(pi-<name>): ...`.

## Remove an extension

Delete `packages/<name>/` (its OpenSpec root goes with it), remove its row from the root README, run `pnpm install` to update the lockfile, and commit as `chore(repo): remove pi-<name>`.

## Upgrade Pi

The root `devDependencies` pin the Pi host packages that provide types, docs, and examples. Keep them at the version of the installed `pi` (`pi --version`). To upgrade: bump all `@earendil-works/*` entries together, run `pnpm install`, read `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` for breaking changes, run `pnpm check`, and smoke-test every package.
