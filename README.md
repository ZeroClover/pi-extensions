# pi-extensions

Extensions for [Pi](https://pi.dev), the terminal coding agent. Each extension in this pnpm monorepo is an independent [Pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) under `packages/`, with its own README, tests, and manifest.

| Package | npm | Description |
|---|---|---|
| [`pi-retry`](packages/pi-retry/) | `@zeroclover/pi-retry` | Retries failed model requests, honouring the wait the provider asks for or backing off exponentially |
| [`pi-rtk`](packages/pi-rtk/) | `@zeroclover/pi-rtk` | Routes shell commands from Pi's bash and third-party exec tools through RTK for compact, token-efficient output |
| [`pi-tps`](packages/pi-tps/) | `@zeroclover/pi-tps` | Footer readout showing live tokens per second and time to first token alongside each model's smoothed averages and session totals |

## Using an extension

Each extension is published independently to npm under `@zeroclover`. Every release creates a Git tag `@zeroclover/<name>@<version>` and a GitHub Release with that version's changelog section; there is no repository-wide version.

Install a published version in user scope (add `--local` for the current project):

```bash
pi install npm:@zeroclover/<name>
```

From a local checkout, load an extension for a single session or install it from its directory:

```bash
pi -e ./packages/<name>
pi install /absolute/path/to/pi-extensions/packages/<name>
```

Installing the repository from git loads every package from that snapshot; use the `extensions` filter in Pi settings to load only specific ones:

```bash
pi install git:github.com/ZeroClover/pi-extensions
```

Each package's README documents its tools, commands, and configuration.

## Layout

```
.
├── packages/<name>/        one Pi package per directory, published as @zeroclover/<name>
├── .changeset/             release intents and the release ledger, written by pnpm change / version
├── tools/e2e/              end-to-end test harness: a real Pi session with a scripted provider and recording UI
├── tools/release/          release checks and publication tooling used by CI, with tests
├── .github/workflows/      CI checks and the release workflow
├── docs/                   architecture, conventions, workflow, releases, and Pi reference
├── openspec/               OpenSpec root for repository-wide changes (packages have their own)
├── .agents/skills/         project skills: pi-extension-dev plus the OpenSpec workflows
├── .claude/                Claude Code commands and skills for OpenSpec (generated)
├── AGENTS.md               rules and index for AI agents; CLAUDE.md is only `@AGENTS.md`
├── package.json            workspace root: shared tooling only, no runtime code
├── tsconfig.base.json      strict TypeScript settings shared by every package
└── biome.json              lint and format rules
```

## Development

All code in this repository is written by AI coding agents following [`AGENTS.md`](AGENTS.md) and [`docs/`](docs/), planned with [OpenSpec](https://github.com/Fission-AI/OpenSpec) (`openspec/` at the root or per package), and reviewed by humans.

Requirements: Node 22 or newer and pnpm (the pinned version in `package.json` is picked up by `corepack enable`).

```bash
pnpm install     # tooling plus the Pi host packages used for types, docs, and examples
pnpm check       # lint + typecheck + tests, including loading every extension in Pi
pnpm lint:fix    # apply formatting and safe lint fixes
```

Pi loads TypeScript directly, so there is no build step. See [`docs/workflow.md`](docs/workflow.md) to add or update an extension, and [`docs/releases.md`](docs/releases.md) for how releases are prepared from change intents and published by CI.

## Documentation

- [`docs/architecture.md`](docs/architecture.md): repository layout and package anatomy
- [`docs/conventions.md`](docs/conventions.md): TypeScript, lint, dependency, and extension design rules
- [`docs/workflow.md`](docs/workflow.md): creating, verifying, and shipping an extension
- [`docs/releases.md`](docs/releases.md): release decisions, version preparation, publication, and recovery
- [`docs/pi-reference.md`](docs/pi-reference.md): where to find Pi's docs, examples, and types

## License

[AGPL-3.0-only](LICENSE)
