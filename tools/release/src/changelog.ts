import { ReleaseError } from "./errors.ts";

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^(#{1,2})(?:[ \t]+(.*?))?[ \t]*$/;

interface Heading {
	readonly index: number;
	readonly level: number;
	readonly text: string;
}

export function changelogPath(dir: string): string {
	return `${dir}/CHANGELOG.md`;
}

/** Level 1 and 2 ATX headings outside fenced code blocks; pnpm writes `# <name>` and `## <version>`. */
function headings(lines: readonly string[]): Heading[] {
	const found: Heading[] = [];
	let fence: string | undefined;
	lines.forEach((raw, index) => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (fence !== undefined) {
			const closing = CLOSING_FENCE.exec(line)?.[1];
			if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) {
				fence = undefined;
			}
			return;
		}
		const opening = OPENING_FENCE.exec(line)?.[1];
		if (opening !== undefined) {
			fence = opening;
			return;
		}
		const heading = HEADING.exec(line);
		if (heading?.[1] !== undefined) {
			found.push({ index, level: heading[1].length, text: heading[2] ?? "" });
		}
	});
	return found;
}

/** How many `## <version>` sections a changelog has. */
export function releaseSectionCount(changelog: string, version: string): number {
	return headings(changelog.split("\n")).filter((heading) => heading.level === 2 && heading.text === version).length;
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

/**
 * The body of the unique `## <version>` section: every byte between its heading and the next
 * level 1 or 2 heading, without the blank lines that separate sections. Missing, duplicate,
 * or empty sections are errors; there is no fallback to generated notes.
 */
export function releaseNotes(changelog: string, version: string, source: string): string {
	const lines = changelog.split("\n");
	const all = headings(lines);
	const matches = all.filter((heading) => heading.level === 2 && heading.text === version);
	const section = matches[0];
	if (section === undefined) {
		throw new ReleaseError(`${source}: no "## ${version}" section`);
	}
	if (matches.length > 1) {
		throw new ReleaseError(
			`${source}: ${matches.length} "## ${version}" sections; a release needs exactly one (was a preparation stacked on an unpublished version?)`,
		);
	}
	const end = all.find((heading) => heading.index > section.index)?.index ?? lines.length;
	const body = lines.slice(section.index + 1, end);
	const first = body.findIndex((line) => !isBlank(line));
	if (first === -1) {
		throw new ReleaseError(`${source}: the "## ${version}" section is empty`);
	}
	const last = body.findLastIndex((line) => !isBlank(line));
	return body.slice(first, last + 1).join("\n");
}
