import { describe, expect, it } from "vitest";
import { identityProblems, isPublishedPath } from "../src/manifest.ts";
import { manifest } from "./fixtures.ts";

const WHERE = "packages/pi-a/package.json";

describe("identityProblems", () => {
	it("accepts the plugin template", () => {
		expect(identityProblems("pi-a", manifest("pi-a", "0.1.0"))).toEqual([]);
	});

	it("checks name, privacy, version, files, and public access", () => {
		const bad = manifest("pi-a", "next", {
			name: "pi-a",
			private: true,
			files: ["src/**", "README.md"],
			publishConfig: { access: "restricted" },
		});
		expect(identityProblems("pi-a", bad)).toEqual([
			`${WHERE}: name must be "@zeroclover/pi-a", found "pi-a"`,
			`${WHERE}: plugins are published; remove "private": true`,
			`${WHERE}: version must be a semver version`,
			`${WHERE}: files entry "src/**" uses a glob or negation; list plain paths`,
			`${WHERE}: "files" must include CHANGELOG.md`,
			`${WHERE}: publishConfig.access must be "public" (scoped packages are private on npm by default)`,
			`${WHERE}: pi.extensions entry "./src/index.ts" is outside "files", so it would not be published`,
		]);
	});

	it("requires plain declared resources inside files", () => {
		const resources = manifest("pi-a", "0.1.0", {
			pi: { extensions: ["./src/index.ts"], prompts: ["./prompts/*.md"], skills: ["./skills"], themes: "dark.json" },
		});
		expect(identityProblems("pi-a", resources)).toEqual([
			`${WHERE}: pi.themes must be a list of paths`,
			`${WHERE}: pi.skills entry "./skills" is outside "files", so it would not be published`,
			`${WHERE}: pi.prompts entry "./prompts/*.md" is a pattern; list plain paths so releases can verify every resource`,
		]);
	});
});

describe("isPublishedPath", () => {
	it("follows files entries and the files npm always packs", () => {
		const plugin = manifest("pi-a", "0.1.0");
		expect(
			["src/index.ts", "README.md", "CHANGELOG.md", "package.json", "LICENSE"].map((path) =>
				isPublishedPath(plugin, path),
			),
		).toEqual([true, true, true, true, true]);
		expect(
			["test/a.test.ts", "openspec/config.yaml", "srcs/x.ts"].map((path) => isPublishedPath(plugin, path)),
		).toEqual([false, false, false]);
	});
});
