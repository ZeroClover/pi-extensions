import { describe, expect, it } from "vitest";
import { continuityProblems } from "../src/authorization.ts";
import { parseLedger } from "../src/ledger.ts";
import { ledger } from "./fixtures.ts";

const KEY = "@zeroclover/pi-a@0.1.0";
const member = {
	key: KEY,
	name: "@zeroclover/pi-a",
	version: "0.1.0",
	dirName: "pi-a",
	record: { dir: "packages/pi-a", intents: ["one"] },
};
const original = ledger({ [KEY]: ["one"] });

describe("continuityProblems", () => {
	it("keeps authority through unrelated later records and formatting-only rewrites", () => {
		const requoted = parseLedger(`'${KEY}': { dir: ./packages/pi-a/, intents: [one] }\n`, "requoted");
		const later = ledger({ [KEY]: ["one"], "@zeroclover/pi-b@1.0.0": ["two"], "@zeroclover/pi-a@0.2.0": ["three"] });
		expect(
			continuityProblems(
				[member],
				[
					{ commit: "f", ledger: requoted },
					{ commit: "u", ledger: later },
				],
			),
		).toEqual([]);
	});

	it("loses authority at a mutation even when the record is later restored", () => {
		const mutated = parseLedger(`"${KEY}":\n  dir: packages/pi-x\n  intents: [one]\n`, "mutated");
		const snapshots = [
			{ commit: "m", ledger: mutated },
			{ commit: "r", ledger: original },
		];
		expect(continuityProblems([member], snapshots)).toEqual([`${KEY} was modified at m`]);
	});

	it("keeps a withdrawn preparation ineligible after an identical record is prepared again", () => {
		const snapshots = [
			{ commit: "R", ledger: new Map() },
			{ commit: "Y", ledger: original },
		];
		expect(continuityProblems([member], snapshots)).toEqual([`${KEY} was removed at R`]);
		expect(continuityProblems([member], snapshots.slice(1))).toEqual([]);
	});
});
