import { type ChangeIntent, parseIntent } from "../src/intents.ts";
import { type Ledger, parseLedger } from "../src/ledger.ts";
import { type PluginManifest, parseManifest } from "../src/manifest.ts";

export function manifestText(dirName: string, version: string, extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify(
		{
			name: `@zeroclover/${dirName}`,
			version,
			description: `${dirName} for tests`,
			license: "AGPL-3.0-only",
			repository: { type: "git", url: "git+https://github.com/ZeroClover/pi-extensions.git" },
			type: "module",
			files: ["src", "README.md", "CHANGELOG.md"],
			publishConfig: { access: "public" },
			pi: { extensions: ["./src/index.ts"] },
			peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
			...extra,
		},
		null,
		"\t",
	)}\n`;
}

export function manifest(dirName: string, version: string, extra: Record<string, unknown> = {}): PluginManifest {
	return parseManifest(manifestText(dirName, version, extra), `${dirName}/package.json`);
}

/** An intent file in the format `pnpm change` writes. */
export function intentText(releases: Record<string, string>, summary: string): string {
	const lines = Object.entries(releases).map(([name, bump]) => `${JSON.stringify(name)}: ${bump}`);
	return `---\n${lines.join("\n")}\n---\n\n${summary}\n`;
}

export function intent(id: string, releases: Record<string, string>, summary: string): ChangeIntent {
	return parseIntent(id, intentText(releases, summary), id);
}

/** A ledger in the format `pnpm version -r` writes. */
export function ledgerText(records: Record<string, readonly string[]>): string {
	return Object.keys(records)
		.sort()
		.map((key) => {
			const name = key.slice(0, key.lastIndexOf("@"));
			const intents = records[key] ?? [];
			return `"${key}":\n  dir: packages/${name.slice(name.indexOf("/") + 1)}\n  intents:\n${intents.map((id) => `    - ${id}\n`).join("")}`;
		})
		.join("");
}

export function ledger(records: Record<string, readonly string[]>): Ledger {
	return parseLedger(ledgerText(records), "ledger");
}

export function changelogText(name: string, sections: readonly (readonly [string, string])[]): string {
	return `# ${name}\n\n${sections.map(([version, body]) => `## ${version}\n\n${body}\n`).join("\n")}`;
}
