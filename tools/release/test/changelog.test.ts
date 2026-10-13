import { describe, expect, it } from "vitest";
import { releaseNotes } from "../src/changelog.ts";

/** Byte-for-byte what pnpm 12.11.2 wrote in the scratch experiment (docs/releases.md). */
const PNPM_CHANGELOG = `# @zeroclover/pi-a

## 0.2.0

### Minor Changes

- A feature

### Patch Changes

- Shared fix for A and B

## 0.1.0

### Patch Changes

- First release
`;

describe("releaseNotes", () => {
	it("extracts the exact-version body of pnpm's format", () => {
		expect(releaseNotes(PNPM_CHANGELOG, "0.2.0", "CHANGELOG.md")).toBe(
			"### Minor Changes\n\n- A feature\n\n### Patch Changes\n\n- Shared fix for A and B",
		);
		expect(releaseNotes(PNPM_CHANGELOG, "0.1.0", "CHANGELOG.md")).toBe("### Patch Changes\n\n- First release");
	});

	it("does not match a version prefix", () => {
		expect(() => releaseNotes("# x\n\n## 0.1.10\n\n- a\n", "0.1.1", "CHANGELOG.md")).toThrow(/no "## 0.1.1" section/);
	});

	it("rejects a missing section", () => {
		expect(() => releaseNotes(PNPM_CHANGELOG, "0.3.0", "CHANGELOG.md")).toThrow(/no "## 0.3.0" section/);
	});

	it("rejects duplicate sections produced by a stacked preparation", () => {
		const stacked =
			"# x\n\n## 0.1.0\n\n### Patch Changes\n\n- Another fix\n\n## 0.1.0\n\n### Patch Changes\n\n- First\n";
		expect(() => releaseNotes(stacked, "0.1.0", "CHANGELOG.md")).toThrow(/2 "## 0.1.0" sections/);
	});

	it("rejects an empty section", () => {
		expect(() => releaseNotes("# x\n\n## 0.2.0\n\n   \n## 0.1.0\n\n- a\n", "0.2.0", "CHANGELOG.md")).toThrow(/empty/);
	});

	it("preserves manually edited prose byte for byte", () => {
		const prose = [
			"### Minor Changes",
			"",
			"- Adds `/tps mode`.  ",
			"  Hard line break above, **bold**, and a nested list:",
			"  - one\r",
			"",
			"```md",
			"## 0.2.0",
			"# not a heading inside a fence",
			"```",
			"",
			"Trailing paragraph \t",
		].join("\n");
		const changelog = `# @zeroclover/pi-a\n\n## 0.2.0\n\n${prose}\n\n## 0.1.0\n\n- a\n`;
		expect(releaseNotes(changelog, "0.2.0", "CHANGELOG.md")).toBe(prose);
	});

	it("reads CRLF changelogs", () => {
		expect(releaseNotes("# x\r\n\r\n## 1.0.0\r\n\r\n- a\r\n", "1.0.0", "CHANGELOG.md")).toBe("- a\r");
	});
});
