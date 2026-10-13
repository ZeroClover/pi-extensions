# pi-extensions

A collection of extensions for [Pi](https://pi.dev), the terminal coding agent. The repository is a pnpm monorepo: each extension is an independent [Pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) in its own directory under `packages/`, with its own README, tests, and manifest.

Everything here is written by AI coding agents. The rules they follow live in [`AGENTS.md`](AGENTS.md) and [`docs/`](docs/); humans review and steer. Changes are planned with [OpenSpec](https://github.com/Fission-AI/OpenSpec): repo-wide work in the root `openspec/`, package work in each package's own `openspec/`.

## Extensions

| Package | Description |
|---|---|
| [`pi-tps`](packages/pi-tps/) | Live tokens-per-second readout in the footer: TTFT, thinking and output speed, stalls, burst detection, calibrated estimates, session averages (`/tps`) |

## Layout

```
.
├── packages/<name>/        one Pi package per directory: src/, test/, README.md, package.json
├── docs/                   architecture, conventions, workflow, and Pi reference
├── openspec/               OpenSpec root for repository-wide changes (packages have their own)
├── .agents/skills/         project skills: pi-extension-dev plus the OpenSpec workflows
├── .claude/                Claude Code commands and skills for OpenSpec (generated)
├── AGENTS.md               rules and index for AI agents; CLAUDE.md is only `@AGENTS.md`
├── package.json            workspace root: shared tooling only, no runtime code
├── tsconfig.base.json      strict TypeScript settings shared by every package
└── biome.json              lint and format rules
```

## Using an extension

Try one for a single session without installing it:

```bash
pi -e ./packages/<name>
```

Install one permanently (user scope; add `--local` for the current project):

```bash
pi install /absolute/path/to/pi-extensions/packages/<name>
```

Installing the repository from git loads every package; narrow it with the `extensions` filter in Pi settings:

```bash
pi install git:github.com/<owner>/pi-extensions
```

Each package's README documents its tools, commands, and configuration.

## Development

Requirements: Node 22 or newer and pnpm (the exact version is pinned in `package.json`; `corepack enable` picks it up).

```bash
pnpm install     # tooling plus the Pi host packages used for types, docs, and examples
pnpm check       # lint + typecheck + tests
pnpm lint:fix    # apply formatting and safe lint fixes
```

Pi loads TypeScript directly, so there is no build step. To add an extension, follow [`docs/workflow.md`](docs/workflow.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md): repository layout and package anatomy
- [`docs/conventions.md`](docs/conventions.md): TypeScript, lint, dependency, and extension design rules
- [`docs/workflow.md`](docs/workflow.md): creating, verifying, and shipping an extension
- [`docs/pi-reference.md`](docs/pi-reference.md): where to find Pi's docs, examples, and types
