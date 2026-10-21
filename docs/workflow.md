# Workflow

## Plan with OpenSpec

Non-trivial work (a new extension, a new tool or command, a behavior change, a removal) is planned with OpenSpec before code is written. Trivial fixes (typos, a one-line bug with an obvious test) and Pi host upgrades ("Track the latest Pi") skip it.

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

Start on the current Pi target ("Track the latest Pi").

1. Choose a name: `pi-<topic>`, lowercase, hyphenated. The directory is `packages/pi-<topic>/` and the npm `name` is `@zeroclover/pi-<topic>`; the commit scope is the bare directory name.
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
     Verification for every change: pnpm check from the repository root (it
     loads the extension in Pi) and the live checks in ../../docs/workflow.md.
   ```

4. Run `pnpm install` so the workspace knows the package.
5. Propose the first change from `packages/<name>/` (see above), then implement it in `src/`, following `docs/conventions.md`. Consult Pi's docs and the closest shipped example (`docs/pi-reference.md`) before using an API.
6. Verify (next section).
7. Write the package `README.md` and add a row to the table in the root `README.md`.
8. Record the release decision (`docs/releases.md`): `pnpm change --bump minor --summary "First release: <what it does>" @zeroclover/pi-<name>` when it should ship, or `--bump none` with the reason it should not yet. Its first release keeps the manifest's `0.1.0`.
9. Archive the change, then commit: `feat(pi-<name>): <summary>`.

### `packages/<name>/package.json`

```json
{
	"name": "@zeroclover/pi-<name>",
	"version": "0.1.0",
	"description": "<one sentence>",
	"license": "AGPL-3.0-only",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/ZeroClover/pi-extensions.git",
		"directory": "packages/pi-<name>"
	},
	"homepage": "https://github.com/ZeroClover/pi-extensions/tree/master/packages/pi-<name>#readme",
	"bugs": {
		"url": "https://github.com/ZeroClover/pi-extensions/issues"
	},
	"type": "module",
	"keywords": ["pi-package", "pi-extension"],
	"files": ["src", "README.md", "CHANGELOG.md"],
	"publishConfig": {
		"access": "public"
	},
	"pi": {
		"extensions": ["./src/index.ts"]
	},
	"peerDependencies": {
		"@earendil-works/pi-coding-agent": "*"
	}
}
```

`files` lists plain paths only and always includes `CHANGELOG.md`, which `pnpm version -r` creates at the first release preparation. Declare `pi` resources as plain paths (files or directories) inside `files`, never globs or `!` exclusions, so release checks can verify them. Do not add `private`. Add `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, or `typebox` to `peerDependencies` as the code imports them. Biome formats `package.json`; run `pnpm lint:fix` after editing it.

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

### `packages/<name>/src/greeting.ts`

```ts
export function greeting(name: string): string {
	return `Hello, ${name.trim() || "world"}!`;
}
```

### `packages/<name>/test/hello.test.ts`

The test loads the package into a real Pi session (`tools/e2e/src/`), lets a scripted model call the tool, and runs the command as a user would (`docs/conventions.md`, "Tests"). Replace the spec anchors once the package has specs.

```ts
import { afterEach, describe, expect, it } from "vitest";
import { type Pi, reply, startPi, text, toolCall } from "../../../tools/e2e/src/index.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

describe("hello", () => {
	// greeting: Hello tool.
	it("answers the model's hello call with a greeting", async () => {
		pi = await startPi({ extensions: ["pi-<name>"] });
		pi.provider.respond(reply(toolCall("hello", { name: "Pi" })), reply(text("done")));
		await pi.prompt("greet Pi");
		expect(pi.toolResults()).toEqual(["Hello, Pi!"]);
	});

	// greeting: Hello command.
	it("shows a greeting for /hello, and greets the world without a name", async () => {
		pi = await startPi({ extensions: ["pi-<name>"] });
		await pi.prompt("/hello Ada");
		await pi.prompt("/hello");
		expect(pi.ui.notices).toEqual([
			{ level: "info", message: "Hello, Ada!" },
			{ level: "info", message: "Hello, world!" },
		]);
	});
});
```

### `packages/<name>/README.md`

```markdown
# pi-<name>

<What it does and why, in one paragraph.>

## Install

Releases are published to npm as `@zeroclover/pi-<name>`; each release is tagged `@zeroclover/pi-<name>@<version>`.

pi install npm:@zeroclover/pi-<name>          # install a published version
pi -e ./packages/<name>                       # try a repository checkout for one session
pi install /absolute/path/to/packages/<name>  # install a repository checkout for the user

## Provides

| Kind | Name | Description |
|---|---|---|
| tool | `hello` | ... |
| command | `/hello` | ... |

## Configuration

<Settings, files, environment variables, or "None.">
```

## Verify

Every source change ends with these, run from the repository root:

1. `pnpm check`: Biome, `tsc`, and Vitest must all pass with no warnings you introduced. Vitest runs every package's end-to-end scenarios, each in a real Pi session with a scripted provider (`tools/e2e/`), the release tooling's CLI scenarios, and loads every package in Pi without a model call (`tools/release/test/load.test.ts`), so a package that fails to load fails `pnpm check`. Run one package's scenarios with `pnpm vitest run packages/<name>`. To see one package's load result or its commands directly:

   ```bash
   printf '{"id":"1","type":"get_commands"}\n' | pnpm exec pi -ne -e ./packages/<name> --mode rpc
   ```

2. For behavior the end-to-end scenarios cannot reach (a real model, a real terminal, a third-party extension), run `pnpm exec pi -ne -e ./packages/<name>` interactively or with `--print` and exercise the feature. `pnpm exec pi` runs the workspace's Pi, the current target, with your usual agent directory and credentials; a globally installed `pi` may be another version. State in the final report exactly what was exercised.

CI repeats `pnpm check` on the pull request and also runs `pnpm change check`, the release-impact gate, and the artifact preflight (`docs/releases.md`); there is no need to run those locally. To debug a failing gate, run it on the committed branch: `node tools/release/src/cli.ts coverage --base origin/master --head HEAD`.

A release preparation pull request changes no source. It is verified by the review in `docs/releases.md` §2 and by CI, not by this section.

A running Pi session keeps the extension code it loaded at startup. After editing `src/`, restart Pi (or `/reload`) before testing again.

## Change an existing extension

Start on the current Pi target ("Track the latest Pi").

1. Read the package README, `openspec/specs/`, and `src/index.ts` first, then the modules you touch.
2. For non-trivial changes, propose from `packages/<name>/` and wait for review.
3. Make the change with its end-to-end scenario; a bug fix adds one that fails before the fix (`docs/conventions.md`, "Tests"). Keep the package's public surface (tool names, command names, settings) stable unless the change is the point.
4. Update the README when tools, commands, flags, or configuration change.
5. Record the release decision with `pnpm change` (`docs/releases.md`): the bump the user-facing change warrants, or `none` with a reason.
6. Verify, archive the change, then commit as `fix(pi-<name>): ...` or `feat(pi-<name>): ...`.

## Remove an extension

Delete `packages/<name>/` (its OpenSpec root goes with it), remove its row from the root README, run `pnpm install` to update the lockfile, and commit as `chore(repo): remove pi-<name>`. Versions already on npm stay there; never unpublish them.

## Release

Releasing is a separate step taken only on an explicit request: prepare versions locally, review, open a release-focused pull request, and let CI publish after the merge. The procedure, including recovery, is `docs/releases.md`.

## Track the latest Pi

There is no fixed Pi version. Extensions are developed, maintained, and verified against Pi's latest stable release: the version the npm `latest` dist-tag of `@earendil-works/pi-coding-agent` names at the time of the work. Prereleases and other dist-tags never become the target.

The root `devDependencies` state the target as exact versions: `@earendil-works/pi-coding-agent` at the target, and `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, and `typebox` at the exact versions that release depends on, not at their own latest releases. They provide the types, docs, and examples (`docs/pi-reference.md`), the host of the end-to-end scenarios and the load test, and the `pi` of `pnpm exec pi`.

Before creating, changing, or debugging an extension, compare the root entry with the registry:

```bash
pnpm view @earendil-works/pi-coding-agent version
```

If it matches, continue. If the registry cannot be reached, continue on the pinned host and say in the report that the target could not be confirmed. If Pi has a newer release, upgrade first. The upgrade is routine maintenance: do it yourself, without an OpenSpec proposal or a separate request, in its own pull request before the extension work.

1. Read the versions to pin: `pnpm view @earendil-works/pi-coding-agent@<version> dependencies`.
2. Set all five root entries to those exact versions (no `^`), then run `pnpm install`.
3. Read `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` for every release since the previous target, and check each breaking change against the APIs the packages use.
4. Run `pnpm check`. Fix every package it breaks in the same pull request, each with its release decision (`docs/releases.md`). A fix that changes a package's user-visible behavior is proposed in that package's OpenSpec root first.
5. Re-verify statements in package READMEs and specs that describe Pi's behavior and name the release they were checked against (`rg -n "Pi [0-9]" packages/*/README.md packages/*/openspec/specs`); update each statement and its label to the new target, with a release decision for each README you change.
6. Commit as `chore(repo): upgrade Pi host to <version>`.

Extensions use the target's API only: no fallbacks, feature detection, or shims for older Pi releases, and no declared minimum version; host packages stay `"*"` peers. CI installs from the frozen lockfile and never compares it with the registry, so a Pi release does not change the result of an existing pull request; the next extension task picks it up.
