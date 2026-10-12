# Architecture

## Repository layout

```
.
├── AGENTS.md                      rules and index for agents
├── CLAUDE.md                      redirect to AGENTS.md
├── README.md                      human overview and extension table
├── docs/                          this documentation
├── .agents/skills/
│   └── pi-extension-dev/SKILL.md  skill loaded when working on an extension
├── packages/
│   └── <name>/                    one Pi package per directory
├── package.json                   workspace root: scripts and dev tooling only
├── pnpm-workspace.yaml            workspace members and build-script policy
├── tsconfig.base.json             shared strict compiler options
├── tsconfig.json                  typecheck entry covering packages/*/src and packages/*/test
├── biome.json                     lint and format rules
└── vitest.config.ts               test discovery (packages/*/test/**/*.test.ts)
```

The root never contains runtime code. It exists so that every package is checked by the same TypeScript, Biome, and Vitest configuration and so that the Pi host packages are installed once, giving the editor and `tsc` their type declarations and giving agents a local copy of Pi's docs and examples.

## Package anatomy

```
packages/<name>/
├── package.json        name, description, pi manifest, peerDependencies, dependencies
├── README.md           what it does, how to install, tools/commands/config it provides
├── src/
│   ├── index.ts        extension entry: default export function (pi: ExtensionAPI)
│   └── *.ts            implementation modules, kept free of Pi API where possible
└── test/
    └── *.test.ts       Vitest tests for the implementation modules
```

Rules that follow from this layout:

- `src/index.ts` is the only file Pi loads. It wires registrations (`pi.registerTool`, `pi.registerCommand`, `pi.on`, ...) to implementation modules. Keep it thin so the logic is testable without a running Pi.
- Logic that does not need `ExtensionAPI` or `ExtensionContext` lives in separate modules under `src/` and gets unit tests under `test/`.
- Relative imports use the `.ts` extension (`import { x } from "./x.ts"`). Pi loads sources through jiti and the compiler is configured with `allowImportingTsExtensions`.
- A package may contain skills, prompt templates, or themes next to its extension; declare them in the `pi` manifest.

## Manifest and dependencies

```json
{
	"name": "pi-<name>",
	"version": "0.1.0",
	"description": "One sentence, shown in package listings",
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

- `pi.extensions` points at the entry explicitly. Pi also discovers a conventional `extensions/` directory, but an explicit manifest keeps `src/` as the single source layout.
- Host-provided packages are declared in `peerDependencies` with `"*"`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `typebox`. List only the ones the package imports.
- Real runtime dependencies go in `dependencies` of the package, not the root. `pnpm install` at the root installs them through the workspace. Installed packages load with their own module root, so a package may not rely on another package's dependencies.
- The root `package.json` carries a `pi` manifest with the glob `./packages/*/src/index.ts` so that installing the whole repository from git loads every package; users narrow it with Pi's resource filters.

## How Pi loads a package

Pi reads `package.json`, resolves the `pi` manifest, and imports each extension entry with jiti. There is no build step and no `dist/`. The default export runs once per extension runtime; a `/reload` replaces the runtime. Because loading happens in-process, an extension has the same permissions as Pi itself.

The full contract (lifecycle, events, tools, state, UI, errors) is in Pi's own documentation; see `docs/pi-reference.md` for where to find it.
