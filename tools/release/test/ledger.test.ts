import { describe, expect, it } from "vitest";
import { diffLedgers, parseLedger, sameLedger, splitReleaseKey } from "../src/ledger.ts";

const PNPM_LEDGER = `"@zeroclover/pi-a@0.1.0":
  dir: packages/pi-a
  intents:
    - gentle-hairs-report
    - orange-mangos-cough
"@zeroclover/pi-b@0.1.0":
  dir: packages/pi-b
  intents:
    - gentle-hairs-report
    - smooth-lamps-yell
`;

describe("parseLedger", () => {
	it("reads the shape pnpm writes", () => {
		const ledger = parseLedger(PNPM_LEDGER, "ledger");
		expect([...ledger.keys()]).toEqual(["@zeroclover/pi-a@0.1.0", "@zeroclover/pi-b@0.1.0"]);
		expect(ledger.get("@zeroclover/pi-b@0.1.0")).toEqual({
			dir: "packages/pi-b",
			intents: ["gentle-hairs-report", "smooth-lamps-yell"],
		});
	});

	it("treats an empty file as an empty ledger", () => {
		expect(parseLedger("", "ledger").size).toBe(0);
		expect(parseLedger("\n  \n", "ledger").size).toBe(0);
	});

	it("reads bare id lists, null entries, and missing intents as pnpm does", () => {
		const ledger = parseLedger('"@x/a@1.0.0": [one]\n"@x/b@1.0.0":\n"@x/c@1.0.0":\n  dir: ./packages/c/\n', "ledger");
		expect(ledger.get("@x/a@1.0.0")).toEqual({ dir: null, intents: ["one"] });
		expect(ledger.get("@x/b@1.0.0")).toEqual({ dir: null, intents: [] });
		expect(ledger.get("@x/c@1.0.0")).toEqual({ dir: "packages/c", intents: [] });
	});

	it("ignores formatting: quoting, flow style, indentation, and intent order", () => {
		const reformatted = `'@zeroclover/pi-b@0.1.0': { dir: "./packages/pi-b", intents: [smooth-lamps-yell, gentle-hairs-report] }
"@zeroclover/pi-a@0.1.0":
    dir: packages/pi-a
    intents: ["orange-mangos-cough", "gentle-hairs-report"]
`;
		expect(sameLedger(parseLedger(PNPM_LEDGER, "a"), parseLedger(reformatted, "b"))).toBe(true);
	});

	it.each([
		["duplicate keys", '"@x/a@1.0.0": []\n"@x/a@1.0.0": []\n'],
		["a key without a version", '"@x/a": []\n'],
		["a non-semver version", '"@x/a@latest": []\n'],
		["an unknown field", '"@x/a@1.0.0":\n  dir: packages/a\n  published: true\n'],
		["a missing dir", '"@x/a@1.0.0":\n  intents: [one]\n'],
		["non-string intents", '"@x/a@1.0.0":\n  dir: packages/a\n  intents: [1]\n'],
		["a list document", "- one\n"],
		["invalid YAML", '"@x/a@1.0.0": [\n'],
	])("rejects %s", (_case, text) => {
		expect(() => parseLedger(text, "ledger")).toThrow(/ledger/);
	});
});

describe("diffLedgers", () => {
	it("separates added, removed, and changed records", () => {
		const before = parseLedger(
			'"@x/a@1.0.0": { dir: packages/a, intents: [one] }\n"@x/b@1.0.0": { dir: packages/b, intents: [two] }\n',
			"before",
		);
		const after = parseLedger(
			'"@x/a@1.0.0": { dir: packages/a, intents: [one, three] }\n"@x/c@1.0.0": { dir: packages/c, intents: [four] }\n',
			"after",
		);
		expect(diffLedgers(before, after)).toEqual({
			added: ["@x/c@1.0.0"],
			removed: ["@x/b@1.0.0"],
			changed: ["@x/a@1.0.0"],
		});
	});
});

describe("splitReleaseKey", () => {
	it("splits on the last @ so scopes survive", () => {
		expect(splitReleaseKey("@zeroclover/pi-tps@0.1.0")).toEqual({ name: "@zeroclover/pi-tps", version: "0.1.0" });
		expect(splitReleaseKey("pi-tps@1.2.3-beta.1+build.5")).toEqual({ name: "pi-tps", version: "1.2.3-beta.1+build.5" });
		expect(splitReleaseKey("@zeroclover/pi-tps")).toBeUndefined();
	});
});
