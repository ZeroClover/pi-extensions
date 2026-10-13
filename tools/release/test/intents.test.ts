import { describe, expect, it } from "vitest";
import { bumpFor, intentIdOf, parseIntent } from "../src/intents.ts";

describe("parseIntent", () => {
	it("reads what pnpm change writes", () => {
		const intent = parseIntent(
			"gentle-hairs-report",
			'---\n"@zeroclover/pi-a": patch\n"@zeroclover/pi-b": minor\n---\n\nShared fix for A and B\n',
			"intent",
		);
		expect([...intent.releases]).toEqual([
			["@zeroclover/pi-a", "patch"],
			["@zeroclover/pi-b", "minor"],
		]);
		expect(intent.summary).toBe("Shared fix for A and B");
	});

	it("accepts a byte order mark, CRLF line ends, and none declarations", () => {
		const intent = parseIntent(
			"x",
			'\uFEFF---\r\n"@zeroclover/pi-a": none\r\n---\r\n\r\nREADME wording only\r\n',
			"intent",
		);
		expect(intent.releases.get("@zeroclover/pi-a")).toBe("none");
		expect(intent.summary).toBe("README wording only");
	});

	it.each([
		["no front matter", "Just text\n"],
		["an unclosed front matter", '---\n"@x/a": patch\n'],
		["an unknown bump", '---\n"@x/a": huge\n---\n\nx\n'],
		["a non-mapping front matter", "---\n- a\n---\n\nx\n"],
	])("rejects %s", (_case, text) => {
		expect(() => parseIntent("x", text, "intent")).toThrow(/intent/);
	});
});

describe("bumpFor", () => {
	it("matches the full name or a ./ directory reference", () => {
		const byName = parseIntent("a", '---\n"@zeroclover/pi-a": minor\n---\n\nx\n', "a");
		const byDir = parseIntent("b", '---\n"./packages/pi-a": patch\n---\n\nx\n', "b");
		const pkg = { name: "@zeroclover/pi-a", dir: "packages/pi-a" };
		expect(bumpFor(byName, pkg)).toBe("minor");
		expect(bumpFor(byDir, pkg)).toBe("patch");
		expect(bumpFor(byName, { name: "@zeroclover/pi-b", dir: "packages/pi-b" })).toBeUndefined();
	});
});

describe("intentIdOf", () => {
	it("recognizes only files pnpm reads as intents", () => {
		expect(intentIdOf(".changeset/calm-cats-resolve.md")).toBe("calm-cats-resolve");
		expect(intentIdOf(".changeset/README.md")).toBeUndefined();
		expect(intentIdOf(".changeset/ledger.yaml")).toBeUndefined();
		expect(intentIdOf(".changeset/nested/x.md")).toBeUndefined();
		expect(intentIdOf("docs/x.md")).toBeUndefined();
	});
});
