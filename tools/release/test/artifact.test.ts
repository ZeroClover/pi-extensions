import { describe, expect, it } from "vitest";
import {
	assertOutside,
	batchOverrides,
	extensionCommands,
	type PackedArtifact,
	packedTarball,
	tarballProblems,
} from "../src/artifact.ts";
import type { PreparedMember } from "../src/batch.ts";
import { changelogText, manifest } from "./fixtures.ts";

const member: PreparedMember = {
	key: "@zeroclover/pi-tps@0.1.0",
	name: "@zeroclover/pi-tps",
	version: "0.1.0",
	dirName: "pi-tps",
	record: { dir: "packages/pi-tps", intents: ["x"] },
	notes: "### Minor Changes\n\n- First release",
};
const changelog = changelogText(member.name, [["0.1.0", member.notes]]);
const entries = [
	"package/LICENSE",
	"package/package.json",
	"package/README.md",
	"package/CHANGELOG.md",
	"package/src/index.ts",
	"package/src/format.ts",
];
const sources = ["package.json", "README.md", "CHANGELOG.md", "src/index.ts", "src/format.ts", "test/format.test.ts"];
const packed = manifest("pi-tps", "0.1.0", { name: "@zeroclover/pi-tps", dependencies: { tokenx: "^2.1.1" } });

describe("tarballProblems", () => {
	it("accepts a TypeScript source package with resources, changelog, and runtime dependencies", () => {
		expect(tarballProblems(member, entries, packed, changelog, sources)).toEqual([]);
	});

	it("requires the changelog, the license, and every declared resource", () => {
		const missing = entries.filter(
			(entry) => entry !== "package/CHANGELOG.md" && entry !== "package/src/index.ts" && entry !== "package/LICENSE",
		);
		expect(tarballProblems(member, missing, packed, undefined, sources)).toEqual([
			"CHANGELOG.md is not packed",
			"LICENSE is not packed",
			"src/index.ts of declared extensions resource ./src/index.ts is not packed",
		]);
	});

	it("requires every file of a declared resource directory and a source for each resource", () => {
		const prompts = manifest("pi-tps", "0.1.0", {
			files: ["src", "prompts", "README.md", "CHANGELOG.md"],
			pi: { extensions: ["./src/index.ts"], prompts: ["./prompts"], skills: ["./skills"] },
		});
		const withPrompts = [...sources, "prompts/review.md", "prompts/fix.md"];
		expect(tarballProblems(member, [...entries, "package/prompts/review.md"], prompts, changelog, withPrompts)).toEqual(
			[
				"declared skills resource ./skills does not exist in the source",
				"prompts/fix.md of declared prompts resource ./prompts is not packed",
			],
		);
	});

	it("fails closed on resource patterns it cannot verify", () => {
		const patterned = manifest("pi-tps", "0.1.0", {
			pi: { extensions: ["./src/index.ts"], prompts: ["./prompts/*.md"] },
		});
		expect(tarballProblems(member, entries, patterned, changelog, sources)).toEqual([
			"pi.prompts entry ./prompts/*.md is a pattern that cannot be verified; list plain paths",
		]);
	});

	it("rejects development files", () => {
		expect(
			tarballProblems(
				member,
				[...entries, "package/test/a.test.ts", "package/openspec/config.yaml"],
				packed,
				changelog,
				sources,
			),
		).toEqual([
			"development file package/test/a.test.ts is packed",
			"development file package/openspec/config.yaml is packed",
		]);
	});

	it("rejects bundled or narrowed host packages and unresolved workspace ranges", () => {
		const bad = manifest("pi-tps", "0.1.0", {
			dependencies: { "@earendil-works/pi-tui": "^1.1.0", "@zeroclover/pi-util": "workspace:^" },
			peerDependencies: { "@earendil-works/pi-coding-agent": "^1.0.0" },
		});
		expect(tarballProblems(member, entries, bad, changelog, sources)).toEqual([
			'peer dependency @earendil-works/pi-coding-agent must use "*", not "^1.0.0"',
			'@earendil-works/pi-tui is provided by Pi; declare it only in peerDependencies with "*"',
			"dependencies.@zeroclover/pi-util still uses workspace:^",
		]);
	});

	it("checks identity, publication metadata, and the packed notes", () => {
		const bare = manifest("pi-tps", "0.1.1", {
			description: "",
			license: undefined,
			repository: undefined,
			publishConfig: {},
		});
		const otherNotes = changelogText(member.name, [["0.1.0", "- different"]]);
		expect(tarballProblems(member, entries, bare, otherNotes, sources)).toEqual([
			"the packed manifest is @zeroclover/pi-tps@0.1.1, not @zeroclover/pi-tps@0.1.0",
			"the packed manifest has no description",
			"the packed manifest has no license",
			"the packed manifest has no repository",
			'the packed manifest lacks publishConfig.access "public"',
			"the packed changelog section differs from the committed release notes",
		]);
	});
});

describe("batchOverrides", () => {
	const packedMember = (
		dirName: string,
		version: string,
		dependencies: Record<string, string> = {},
	): PackedArtifact => ({
		member: {
			key: `@zeroclover/${dirName}@${version}`,
			name: `@zeroclover/${dirName}`,
			version,
			dirName,
			record: { dir: `packages/${dirName}`, intents: ["x"] },
			notes: "- x",
		},
		tarball: `/out/${dirName}-${version}.tgz`,
		manifest: manifest(dirName, version, { dependencies }),
	});

	it("covers transitive dependencies between batch members, edge by edge", () => {
		const batch = [
			packedMember("pi-a", "1.0.0", { "@zeroclover/pi-b": "^1.0.0" }),
			packedMember("pi-b", "1.0.0", { "@zeroclover/pi-c": "^1.0.0" }),
			packedMember("pi-c", "1.0.0"),
		];
		expect(batchOverrides(batch)).toEqual({
			"@zeroclover/pi-a@1.0.0>@zeroclover/pi-b": "file:/out/pi-b-1.0.0.tgz",
			"@zeroclover/pi-b@1.0.0>@zeroclover/pi-c": "file:/out/pi-c-1.0.0.tgz",
		});
	});

	it("leaves a dependency on another version of a member to the registry", () => {
		const batch = [
			packedMember("pi-a", "1.0.0", { "@zeroclover/pi-b": "^2.0.0", "@zeroclover/pi-c": "^1.0.0" }),
			packedMember("pi-b", "2.0.0"),
			packedMember("pi-c", "1.0.0", { "@zeroclover/pi-b": "^1.0.0" }),
		];
		expect(batchOverrides(batch)).toEqual({
			"@zeroclover/pi-a@1.0.0>@zeroclover/pi-b": "file:/out/pi-b-2.0.0.tgz",
			"@zeroclover/pi-a@1.0.0>@zeroclover/pi-c": "file:/out/pi-c-1.0.0.tgz",
		});
	});
});

describe("extensionCommands", () => {
	it("reads extension commands from Pi's RPC answer", () => {
		const answer = JSON.stringify({
			id: "1",
			type: "response",
			command: "get_commands",
			success: true,
			data: {
				commands: [
					{ name: "tps", source: "extension" },
					{ name: "fix-tests", source: "prompt" },
					{ name: "alpha", source: "extension" },
				],
			},
		});
		expect(extensionCommands(`{"type":"agent_start"}\n${answer}\n`)).toEqual(["alpha", "tps"]);
	});

	it("fails without an answer or on an unsuccessful one", () => {
		expect(() => extensionCommands("")).toThrow(/did not answer/);
		expect(() =>
			extensionCommands(JSON.stringify({ type: "response", command: "get_commands", success: false, error: "x" })),
		).toThrow(/without commands/);
	});
});

describe("packedTarball", () => {
	it("resolves relative and absolute pnpm pack filenames", () => {
		expect(packedTarball('{"filename":"zeroclover-pi-tps-0.1.0.tgz"}', "/out")).toBe(
			"/out/zeroclover-pi-tps-0.1.0.tgz",
		);
		expect(packedTarball('{"filename":"/tmp/x/zeroclover-pi-tps-0.1.0.tgz"}', "/out")).toBe(
			"/tmp/x/zeroclover-pi-tps-0.1.0.tgz",
		);
		expect(() => packedTarball("not json", "/out")).toThrow(/no JSON/);
	});
});

describe("assertOutside", () => {
	it("refuses scratch directories inside the workspace", () => {
		expect(() => assertOutside("/repo", "/repo/tmp")).toThrow(/inside the workspace/);
		expect(() => assertOutside("/repo", "/repo")).toThrow(/inside the workspace/);
		expect(() => assertOutside("/repo", "/tmp/release")).not.toThrow();
	});
});
