import { describe, expect, it } from "vitest";
import {
	boundaryProblems,
	classifyTransition,
	compareEndpoints,
	findIntegration,
	publicationOrder,
	unpreparedVersionChanges,
	validateMember,
	withdrawalProblems,
} from "../src/batch.ts";
import { parseLedger } from "../src/ledger.ts";
import { changelogText, intent, ledger, manifest } from "./fixtures.ts";

const A = "@zeroclover/pi-a";
const B = "@zeroclover/pi-b";

describe("compareEndpoints", () => {
	it("reports identical records as a no-op, even when formatting changed", () => {
		const before = ledger({ [`${A}@0.1.0`]: ["one"] });
		const after = parseLedger(`'${A}@0.1.0': { dir: ./packages/pi-a, intents: [one] }\n`, "after");
		expect(compareEndpoints(before, after)).toEqual({
			kind: "no-op",
			reason: "release records are identical at both push endpoints",
		});
	});

	it("skips an initial push without records and rejects one with records", () => {
		expect(compareEndpoints(undefined, new Map()).kind).toBe("no-op");
		expect(() => compareEndpoints(undefined, ledger({ [`${A}@0.1.0`]: ["one"] }))).toThrow(/initial push/);
	});

	it("asks for evaluation when records changed", () => {
		expect(compareEndpoints(new Map(), ledger({ [`${A}@0.1.0`]: ["one"] }))).toEqual({ kind: "changed" });
	});
});

describe("boundaryProblems", () => {
	const ok = { before: "p", after: "c", forced: false, parents: ["p"] };

	it("accepts one squash or merge commit on top of the prior tip", () => {
		expect(boundaryProblems(ok)).toEqual([]);
		expect(boundaryProblems({ ...ok, parents: ["p", "side"] })).toEqual([]);
	});

	it("rejects a preparation hidden behind a later commit of the same push", () => {
		expect(boundaryProblems({ ...ok, parents: ["c1"] })).toEqual([expect.stringMatching(/more than one integration/)]);
	});

	it("rejects forced pushes, octopus merges, and parentless commits", () => {
		expect(boundaryProblems({ ...ok, forced: true })).toEqual([expect.stringMatching(/forced/)]);
		expect(boundaryProblems({ ...ok, parents: ["p", "x", "y"] })).toEqual([expect.stringMatching(/3 parents/)]);
		expect(boundaryProblems({ ...ok, parents: [] })).toEqual([expect.stringMatching(/no parent/)]);
	});
});

describe("findIntegration", () => {
	const merged = { number: 7, merged: true, mergeCommitSha: "c", baseRef: "master" };

	const previous = { number: 6, merged: true, mergeCommitSha: "p", baseRef: "master" };

	it("finds the pull request merged as this commit into the default branch", () => {
		expect(findIntegration("c", "master", ["p"], [merged], [previous]).number).toBe(7);
		expect(findIntegration("c", "master", ["p", "side"], [merged], []).number).toBe(7);
	});

	it("rejects a rebase merge, whose first parent comes from the same pull request", () => {
		const rebased = { ...merged, mergeCommitSha: "c" };
		expect(() => findIntegration("c", "master", ["c1"], [rebased], [{ ...rebased, mergeCommitSha: "c" }])).toThrow(
			/both come from pull request #7: a rebase merge/,
		);
	});

	it.each([
		["an unmerged pull request", { ...merged, merged: false }],
		["another merge commit", { ...merged, mergeCommitSha: "other" }],
		["another base branch", { ...merged, baseRef: "release" }],
	])("rejects %s", (_case, pull) => {
		expect(() => findIntegration("c", "master", ["p"], [pull], [previous])).toThrow(/not the squash or merge commit/);
	});
});

describe("classifyTransition", () => {
	it("selects only records new in this commit (A only)", () => {
		const parent = ledger({ [`${B}@2.1.2`]: ["old"] });
		const source = ledger({ [`${B}@2.1.2`]: ["old"], [`${A}@0.1.2`]: ["fix"] });
		const transition = classifyTransition(parent, source);
		expect(transition.kind === "release" && transition.members.map((m) => m.key)).toEqual([`${A}@0.1.2`]);
	});

	it("releases independent versions together without a shared version", () => {
		const transition = classifyTransition(new Map(), ledger({ [`${A}@0.1.2`]: ["x"], [`${B}@2.1.3`]: ["y"] }));
		expect(transition.kind === "release" && transition.members.map((m) => [m.name, m.version, m.dirName])).toEqual([
			[A, "0.1.2", "pi-a"],
			[B, "2.1.3", "pi-b"],
		]);
	});

	it("rejects modified records, even with an unchanged key count", () => {
		const parent = ledger({ [`${A}@0.1.0`]: ["one"] });
		expect(() => classifyTransition(parent, ledger({ [`${A}@0.1.0`]: ["one", "two"] }))).toThrow(/modified/);
	});

	it("treats pure removal as a withdrawal candidate and mixed changes as errors", () => {
		const parent = ledger({ [`${A}@0.1.0`]: ["one"] });
		expect(classifyTransition(parent, new Map())).toEqual({
			kind: "withdrawal",
			removed: [{ key: `${A}@0.1.0`, name: A, version: "0.1.0", record: { dir: "packages/pi-a", intents: ["one"] } }],
		});
		expect(() => classifyTransition(parent, ledger({ [`${B}@1.0.0`]: ["two"] }))).toThrow(/adds .* and removes/);
	});

	it("rejects unscoped, foreign-scope, misplaced, and intent-less records", () => {
		const records = parseLedger(
			[
				'"pi-a@1.0.0": { dir: packages/pi-a, intents: [x] }',
				'"@other/pi-a@1.0.0": { dir: packages/pi-a, intents: [x] }',
				'"@zeroclover/pi-b@1.0.0": { dir: packages/elsewhere, intents: [x] }',
				'"@zeroclover/pi-c@1.0.0": { dir: packages/pi-c, intents: [] }',
				"",
			].join("\n"),
			"source",
		);
		let message = "";
		try {
			classifyTransition(new Map(), records);
		} catch (error) {
			message = error instanceof Error ? error.message : "";
		}
		expect(message.split("\n").sort()).toEqual([
			"@other/pi-a@1.0.0: only @zeroclover/<package> plugins are released",
			'@zeroclover/pi-b@1.0.0: the record\'s dir "packages/elsewhere" must be packages/pi-b',
			"@zeroclover/pi-c@1.0.0: the record consumed no change intent; only changeset-backed preparations release",
			"pi-a@1.0.0: only @zeroclover/<package> plugins are released",
		]);
	});
});

describe("validateMember", () => {
	const member = {
		key: `${A}@0.1.0`,
		name: A,
		version: "0.1.0",
		dirName: "pi-a",
		record: { dir: "packages/pi-a", intents: ["first"] },
	};
	const evidence = {
		manifest: manifest("pi-a", "0.1.0"),
		changelog: changelogText(A, [["0.1.0", "### Minor Changes\n\n- First release"]]),
		parentIntents: new Map([["first", intent("first", { [A]: "minor" }, "First release")]]),
		consumedAtParent: new Set<string>(),
	};

	it("accepts a first release whose manifest keeps its initial version", () => {
		expect(validateMember(member, evidence).notes).toBe("### Minor Changes\n\n- First release");
	});

	it("reports every problem of an invalid member", () => {
		expect(() =>
			validateMember(member, {
				manifest: manifest("pi-a", "0.2.0", { private: true }),
				changelog: changelogText(A, [["0.2.0", "- x"]]),
				parentIntents: new Map([["first", intent("first", { [A]: "none" }, "No release")]]),
				consumedAtParent: new Set(),
			}),
		).toThrow(
			/remove "private"[\s\S]*version 0.2.0, not 0.1.0[\s\S]*not a pending release intent[\s\S]*no "## 0.1.0" section/,
		);
	});

	it("rejects a record whose intent never existed at the parent", () => {
		expect(() => validateMember(member, { ...evidence, parentIntents: new Map([["first", undefined]]) })).toThrow(
			/consumed intent "first"/,
		);
	});

	it("does not mistake a shared intent kept for another plugin for a pending release of this one", () => {
		const shared = intent("shared", { [A]: "patch", [B]: "patch" }, "Shared fix");
		const evidenceForShared = { ...evidence, parentIntents: new Map([["shared", shared]]) };
		const reuse = { ...member, record: { dir: "packages/pi-a", intents: ["shared"] } };
		expect(() => validateMember(reuse, { ...evidenceForShared, consumedAtParent: new Set(["shared"]) })).toThrow(
			/"shared" had already been consumed by @zeroclover\/pi-a/,
		);
		expect(validateMember(reuse, evidenceForShared).key).toBe(`${A}@0.1.0`);
	});
});

describe("withdrawalProblems", () => {
	const removed = {
		key: `${B}@2.1.3`,
		name: B,
		version: "2.1.3",
		record: { dir: "packages/pi-b", intents: ["b-fix", "shared"] },
	};
	const pending = new Map([
		["b-fix", intent("b-fix", { [B]: "patch" }, "B fix")],
		["shared", intent("shared", { [A]: "patch", [B]: "patch" }, "Shared fix")],
	]);
	const restored = {
		ledger: ledger({ [`${B}@2.1.2`]: ["earlier"] }),
		manifest: manifest("pi-b", "2.1.2"),
		changelog: changelogText(B, [["2.1.2", "- Earlier"]]),
		intents: pending,
	};

	it("accepts a revert that restores intents, changelog, and version", () => {
		expect(withdrawalProblems(removed, restored)).toEqual([]);
	});

	it("lets a first release keep its version", () => {
		const first = { ...removed, key: `${B}@0.1.0`, version: "0.1.0" };
		expect(
			withdrawalProblems(first, {
				...restored,
				ledger: new Map(),
				manifest: manifest("pi-b", "0.1.0"),
				changelog: undefined,
			}),
		).toEqual([]);
	});

	it("reports intents, changelog sections, and versions that were not restored", () => {
		const incomplete = {
			ledger: ledger({ [`${B}@2.1.2`]: ["earlier", "shared"] }),
			manifest: manifest("pi-b", "2.1.3"),
			changelog: changelogText(B, [
				["2.1.3", "- B fix"],
				["2.1.2", "- Earlier"],
			]),
			intents: new Map([
				["b-fix", undefined],
				["shared", pending.get("shared")],
			]),
		};
		expect(withdrawalProblems(removed, incomplete)).toEqual([
			`${B}@2.1.3: intent "b-fix" is not restored as a pending release intent for ${B}`,
			`${B}@2.1.3: intent "shared" is not restored as a pending release intent for ${B}`,
			`${B}@2.1.3: packages/pi-b/CHANGELOG.md still has the "## 2.1.3" section`,
			`${B}@2.1.3: packages/pi-b/package.json has version 2.1.3; the withdrawal must restore 2.1.2, the version before the withdrawn preparation`,
		]);
	});

	it("requires exactly the version before the preparation, not any other", () => {
		const bumped = { ...restored, manifest: manifest("pi-b", "99.0.0") };
		expect(withdrawalProblems(removed, bumped)).toEqual([
			`${B}@2.1.3: packages/pi-b/package.json has version 99.0.0; the withdrawal must restore 2.1.2, the version before the withdrawn preparation`,
		]);
		const highest = { ...restored, ledger: ledger({ [`${B}@2.1.10`]: ["later"], [`${B}@2.1.2`]: ["earlier"] }) };
		expect(withdrawalProblems(removed, highest)).toEqual([
			`${B}@2.1.3: packages/pi-b/package.json has version 2.1.2; the withdrawal must restore 2.1.10, the version before the withdrawn preparation`,
		]);
		const first = { ...removed, key: `${B}@0.1.0`, version: "0.1.0" };
		expect(
			withdrawalProblems(first, {
				...restored,
				ledger: new Map(),
				manifest: manifest("pi-b", "0.2.0"),
				changelog: undefined,
			}),
		).toEqual([
			`${B}@0.1.0: packages/pi-b/package.json has version 0.2.0; the withdrawal must restore 0.1.0, the version before the withdrawn preparation`,
		]);
	});
});

describe("publicationOrder", () => {
	const member = (dirName: string) => ({
		key: `@zeroclover/${dirName}@1.0.0`,
		name: `@zeroclover/${dirName}`,
		version: "1.0.0",
		dirName,
		record: { dir: `packages/${dirName}`, intents: ["x"] },
	});

	it("publishes batch members after the batch members they depend on", () => {
		const manifests = new Map([
			["pi-a", manifest("pi-a", "1.0.0", { dependencies: { "@zeroclover/pi-c": "^1.0.0", tokenx: "^2.1.1" } })],
			["pi-b", manifest("pi-b", "1.0.0")],
			["pi-c", manifest("pi-c", "1.0.0", { optionalDependencies: { "@zeroclover/pi-b": "workspace:^" } })],
		]);
		const order = publicationOrder([member("pi-a"), member("pi-b"), member("pi-c")], manifests);
		expect(order.map((entry) => entry.dirName)).toEqual(["pi-b", "pi-c", "pi-a"]);
	});

	it("ignores dependencies on other versions of a member and on peers", () => {
		const manifests = new Map([
			["pi-a", manifest("pi-a", "1.0.0", { dependencies: { "@zeroclover/pi-b": "^0.9.0" } })],
			["pi-b", manifest("pi-b", "1.0.0", { peerDependencies: { "@zeroclover/pi-a": "*" } })],
		]);
		const order = publicationOrder([member("pi-b"), member("pi-a")], manifests);
		expect(order.map((entry) => entry.dirName)).toEqual(["pi-a", "pi-b"]);
	});

	it("rejects a dependency cycle inside one batch", () => {
		const manifests = new Map([
			["pi-a", manifest("pi-a", "1.0.0", { dependencies: { "@zeroclover/pi-b": "^1.0.0" } })],
			["pi-b", manifest("pi-b", "1.0.0", { dependencies: { "@zeroclover/pi-a": "^1.0.0" } })],
		]);
		expect(() => publicationOrder([member("pi-a"), member("pi-b")], manifests)).toThrow(/cycle/);
	});
});

describe("unpreparedVersionChanges", () => {
	const parent = new Map([["pi-a", manifest("pi-a", "0.1.0")]]);

	it("allows prepared and withdrawn versions only", () => {
		const bumped = new Map([["pi-a", manifest("pi-a", "0.2.0")]]);
		expect(unpreparedVersionChanges(parent, bumped, new Set([`${A}@0.2.0`]))).toEqual([]);
		expect(unpreparedVersionChanges(bumped, parent, new Set(), new Set([`${A}@0.2.0`]))).toEqual([]);
		expect(unpreparedVersionChanges(parent, bumped, new Set())).toEqual([expect.stringMatching(/0.1.0 -> 0.2.0/)]);
	});
});
