import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTERS } from "../src/adapters.ts";
import { loadConfig, parseConfig } from "../src/config.ts";

const builtins = new Map(Object.entries(BUILTIN_ADAPTERS));

describe("parseConfig", () => {
	it("uses the built-in tools without a file", () => {
		expect(parseConfig(undefined, "f")).toEqual({ adapters: builtins, warnings: [] });
	});

	it("adds, replaces, and removes tools", () => {
		const { adapters, warnings } = parseConfig(
			JSON.stringify({
				tools: {
					bg_run: { commandField: "command" },
					exec_command: { commandField: "command", shellField: "shell" },
					bash: false,
				},
			}),
			"f",
		);
		expect(warnings).toEqual([]);
		expect([...adapters.keys()].sort()).toEqual(["bg_run", "exec_command"]);
		expect(adapters.get("bg_run")).toEqual({ commandField: "command" });
		expect(adapters.get("exec_command")).toEqual({ commandField: "command", shellField: "shell" });
	});

	it("warns once per problem and keeps the built-in state of the affected entry", () => {
		const { adapters, warnings } = parseConfig(
			JSON.stringify({
				mode: "fast",
				tools: {
					a: { shellField: "shell" },
					b: { commandField: "", extra: 1 },
					c: "command",
					exec_command: { commandField: 3 },
				},
			}),
			"f",
		);
		expect(adapters).toEqual(builtins);
		expect(warnings).toEqual([
			"pi-rtk: f: mode: unknown setting ignored",
			"pi-rtk: f: tools.a: commandField is required; tool ignored",
			"pi-rtk: f: tools.b.extra: unknown setting ignored",
			"pi-rtk: f: tools.b.commandField: expected a non-empty input field name; ignored",
			"pi-rtk: f: tools.b: commandField is required; tool ignored",
			"pi-rtk: f: tools.c: expected an adapter object or false; ignored",
			"pi-rtk: f: tools.exec_command.commandField: expected a non-empty input field name; ignored",
			"pi-rtk: f: tools.exec_command: commandField is required; tool ignored",
		]);
	});

	it("falls back to the built-in tools on invalid JSON or shape", () => {
		expect(parseConfig("{", "f").adapters).toEqual(builtins);
		expect(parseConfig("{", "f").warnings[0]).toMatch(/^pi-rtk: f: invalid JSON/);
		expect(parseConfig("[]", "f").warnings).toEqual(["pi-rtk: f: expected a JSON object; using the built-in tools"]);
		expect(parseConfig('{"tools": []}', "f").adapters).toEqual(builtins);
	});
});

describe("loadConfig", () => {
	it("reads the file, and treats a missing file as no configuration", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-rtk-"));
		const path = join(dir, "pi-rtk.json");
		expect(await loadConfig(path)).toEqual({ adapters: builtins, warnings: [] });
		await writeFile(path, JSON.stringify({ tools: { bash: false } }));
		expect([...(await loadConfig(path)).adapters.keys()]).toEqual(["exec_command"]);
	});

	it("warns when the path cannot be read", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-rtk-"));
		const { adapters, warnings } = await loadConfig(dir);
		expect(adapters).toEqual(builtins);
		expect(warnings[0]).toMatch(/cannot read/);
	});
});
