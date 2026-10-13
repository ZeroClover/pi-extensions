import { describe, expect, it } from "vitest";
import { type CoverageInput, evaluateCoverage } from "../src/coverage.ts";
import { intent, manifest } from "./fixtures.ts";

const A = "@zeroclover/pi-a";
const B = "@zeroclover/pi-b";

function input(overrides: Partial<CoverageInput>): CoverageInput {
	return {
		changedPaths: [],
		plugins: [
			{ dirName: "pi-a", manifest: manifest("pi-a", "0.1.0") },
			{ dirName: "pi-b", manifest: manifest("pi-b", "1.0.0") },
		],
		baseIntents: new Map(),
		headIntents: new Map(),
		prepared: new Set(),
		withdrawn: new Map(),
		consumed: new Map(),
		...overrides,
	};
}

function decisions(overrides: Partial<CoverageInput>): Record<string, string | undefined> {
	return Object.fromEntries(evaluateCoverage(input(overrides)).map((plugin) => [plugin.name, plugin.decision]));
}

describe("evaluateCoverage", () => {
	it("requires a decision for changed source, manifests, and declared resources", () => {
		expect(
			decisions({
				changedPaths: ["packages/pi-a/src/index.ts", "packages/pi-b/package.json", "packages/pi-b/README.md"],
			}),
		).toEqual({ [A]: undefined, [B]: undefined });
	});

	it("ignores tests, OpenSpec, root tooling, and repository documentation", () => {
		expect(
			decisions({
				changedPaths: [
					"packages/pi-a/test/index.test.ts",
					"packages/pi-a/openspec/specs/x/spec.md",
					"tools/release/src/cli.ts",
					"docs/releases.md",
					"package.json",
				],
			}),
		).toEqual({});
	});

	it("accepts a new positive intent", () => {
		const added = intent("calm-cats", { [A]: "minor" }, "Adds /a");
		expect(
			decisions({ changedPaths: ["packages/pi-a/src/a.ts"], headIntents: new Map([["calm-cats", added]]) }),
		).toEqual({
			[A]: "minor release (.changeset/calm-cats.md)",
		});
	});

	it("does not let an unchanged pending intent from the base branch cover a new change", () => {
		const stale = intent("old", { [A]: "minor" }, "Older feature");
		expect(
			decisions({
				changedPaths: ["packages/pi-a/src/a.ts"],
				baseIntents: new Map([["old", stale]]),
				headIntents: new Map([["old", stale]]),
			}),
		).toEqual({ [A]: undefined });
	});

	it("counts a meaningfully updated intent", () => {
		const before = intent("old", { [A]: "patch" }, "Fix");
		const after = intent("old", { [A]: "patch" }, "Fix, and also handle empty input");
		expect(
			decisions({
				changedPaths: ["packages/pi-a/src/a.ts"],
				baseIntents: new Map([["old", before]]),
				headIntents: new Map([["old", after]]),
			})[A],
		).toBe("patch release (.changeset/old.md)");
	});

	it("accepts a reasoned none declaration but not one without a reason", () => {
		const reasoned = intent("docs", { [A]: "none" }, "README wording only");
		const bare = intent("bare", { [B]: "none" }, "");
		expect(
			decisions({
				changedPaths: ["packages/pi-a/README.md", "packages/pi-b/README.md"],
				headIntents: new Map([
					["docs", reasoned],
					["bare", bare],
				]),
			}),
		).toEqual({ [A]: "no release (.changeset/docs.md)", [B]: undefined });
	});

	it("accepts prepared records for preparation-only changes whose intents were consumed", () => {
		expect(
			decisions({
				changedPaths: [
					"packages/pi-a/package.json",
					"packages/pi-a/CHANGELOG.md",
					".changeset/ledger.yaml",
					".changeset/old.md",
				],
				baseIntents: new Map([["old", intent("old", { [A]: "patch" }, "Fix")]]),
				prepared: new Set([A]),
			}),
		).toEqual({ [A]: "prepared release record" });
	});

	it("does not count a shared intent that the plugin has already consumed", () => {
		const before = intent("shared", { [A]: "patch", [B]: "patch" }, "Shared fix");
		const after = intent("shared", { [A]: "patch", [B]: "patch" }, "Shared fix, reworded for A");
		expect(
			decisions({
				changedPaths: ["packages/pi-a/src/a.ts", "packages/pi-b/src/b.ts", ".changeset/shared.md"],
				baseIntents: new Map([["shared", before]]),
				headIntents: new Map([["shared", after]]),
				consumed: new Map([[B, new Set(["shared"])]]),
			}),
		).toEqual({ [A]: "patch release (.changeset/shared.md)", [B]: undefined });
	});

	it("accepts a validated withdrawal for the reverted release files", () => {
		expect(
			decisions({
				changedPaths: ["packages/pi-b/package.json", "packages/pi-b/CHANGELOG.md", ".changeset/ledger.yaml"],
				withdrawn: new Map([[B, `${B}@1.0.1`]]),
			}),
		).toEqual({ [B]: `withdrawal of ${B}@1.0.1` });
	});

	it("accepts a ./ directory reference", () => {
		const byDir = intent("dir", { "./packages/pi-a": "patch" }, "Fix");
		expect(decisions({ changedPaths: ["packages/pi-a/src/a.ts"], headIntents: new Map([["dir", byDir]]) })[A]).toBe(
			"patch release (.changeset/dir.md)",
		);
	});
});
