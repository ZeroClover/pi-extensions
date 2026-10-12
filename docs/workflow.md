# Workflow

## Create a new extension

1. Choose a name: `pi-<topic>`, lowercase, hyphenated. The directory and the package `name` match.
2. Create the package from the templates below. Replace `<name>` and the placeholder text.
3. Run `pnpm install` so the workspace knows the package.
4. Implement in `src/`, following `docs/conventions.md`. Consult Pi's docs and the closest shipped example (`docs/pi-reference.md`) before using an API.
5. Verify (next section).
6. Write the package `README.md` and add a row to the table in the root `README.md`.
7. Commit: `feat(pi-<name>): <summary>`.

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

1. Read the package README and `src/index.ts` first, then the modules you touch.
2. Make the change with its test. Keep the package's public surface (tool names, command names, settings) stable unless the change is the point.
3. Update the README when tools, commands, flags, or configuration change.
4. Verify, then commit as `fix(pi-<name>): ...` or `feat(pi-<name>): ...`.

## Remove an extension

Delete `packages/<name>/`, remove its row from the root README, run `pnpm install` to update the lockfile, and commit as `chore(repo): remove pi-<name>`.

## Upgrade Pi

The root `devDependencies` pin the Pi host packages that provide types, docs, and examples. Keep them at the version of the installed `pi` (`pi --version`). To upgrade: bump all `@earendil-works/*` entries together, run `pnpm install`, read `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` for breaking changes, run `pnpm check`, and smoke-test every package.
