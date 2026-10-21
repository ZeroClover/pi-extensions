# Pi reference

Pi's own documentation, examples, and type declarations are the source of truth for its API. They ship inside the host package and are installed by `pnpm install`, so the copy under `node_modules` is the version the root `package.json` pins: Pi's latest stable release, kept current as `docs/workflow.md`, "Track the latest Pi", describes.

```
node_modules/@earendil-works/pi-coding-agent/
├── docs/            Markdown documentation
├── examples/
│   ├── extensions/  ~80 checked extension examples with a README index
│   ├── plugins/     experimental plugin package example
│   └── sdk/         programmatic usage
├── dist/index.d.ts  exported types (ExtensionAPI, ExtensionContext, events, tools)
└── CHANGELOG.md     breaking changes per version
```

Read a doc completely and follow its cross-references before using an API from it. Do not rely on memory of Pi's API: names and contracts change between versions.

## Which doc for which task

| Task | Read |
|---|---|
| Any extension work: lifecycle, events, tools, state, UI, errors | `docs/extensions.md` |
| Package manifest, dependencies, install sources | `docs/packages.md` |
| Custom terminal components, overlays, themes, input | `docs/tui.md`, then `docs/themes.md` |
| Adding a model provider or OAuth | `docs/custom-provider.md`, `docs/providers.md` |
| Routing requests between models | `docs/virtual-models.md` |
| Compaction hooks | `docs/compaction.md` |
| Message and session entry shapes | `docs/message-types.md`, `docs/session-format.md` |
| Skills, prompt templates, themes bundled with a package | `docs/skills.md`, `docs/prompt-templates.md`, `docs/themes.md` |
| MCP servers registered by an extension | `docs/mcp.md` |
| Non-interactive modes (print, JSON, RPC) your extension must survive | `docs/cli.md`, `docs/json.md`, `docs/rpc.md`, `docs/rpc-extension-ui.md` |
| Keybindings and shortcuts | `docs/keybindings.md` |
| Settings and resource paths | `docs/settings.md`, `docs/configuration.md` |
| Codemode tools and `exposure` | `docs/codemode.md` |

## Which example for which need

`examples/extensions/README.md` is the full index. Starting points:

| Need | Example |
|---|---|
| Minimal tool | `hello.ts` |
| Tool with state, custom rendering, and a command | `todo.ts` |
| Confirm or block tool calls | `permission-gate.ts`, `protected-paths.ts` |
| Register tools dynamically | `dynamic-tools.ts` |
| Large output truncation | `truncated-tool.ts` |
| Commands, flags, shortcuts | `commands.ts`, `preset.ts` |
| Status, widgets, footer, header | `status-line.ts`, `widget-placement.ts`, `custom-footer.ts` |
| Custom interactive component or overlay | `question.ts`, `questionnaire.ts`, `overlay-qa-tests.ts` |
| System prompt changes | `pirate.ts`, `system-prompt-header.ts`, `prompt-customizer.ts` |
| Session entries and renderers | `entry-renderer.ts`, `message-renderer.ts` |
| Extension with npm dependencies | `with-deps/` |
| Multi-file extension | `plan-mode/`, `subagent/` |
| Provider integration | `custom-provider-anthropic/`, `custom-provider-gitlab-duo/` |
| Git hooks | `git-checkpoint.ts`, `auto-commit-on-exit.ts` |

## Looking up a type

```bash
rg -n "interface ExtensionAPI|export type ExtensionEvents|interface ToolDefinition" node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts
```

The declaration file is large; search for the symbol rather than reading it top to bottom. Event payloads and return types are declared next to the event name.

## Contracts that are easy to get wrong

Pulled from `docs/extensions.md`; the doc has the full rules.

- The factory runs without a session in some invocations. Start resources on `session_start`.
- Handlers run in registration order; a `tool_call` handler that throws blocks the tool.
- Tool calls in one assistant message may run in parallel.
- `turn_end` and `agent_before_settle` may request one continuation; guard the condition or it loops.
- `context` must not touch system messages; `context_with_system` must keep a system message at index 0.
- `ctx.reload()`, `waitForIdle()`, and session switching are command-only; calling them from event handlers can deadlock.
- Tools cannot be unregistered; re-register with `exposure: "hidden"`.
- Reconstruct branch-sensitive state from `getBranch()`, not from all file entries.
