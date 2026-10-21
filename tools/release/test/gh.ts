import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A pull request as `GET repos/{repo}/commits/{sha}/pulls` returns it, with the fields the CLI reads. */
export interface PullJson {
	readonly number: number;
	readonly merged_at: string | null;
	readonly merge_commit_sha: string | null;
	readonly base: { readonly ref: string };
}

/** What the `gh` stub answers from and records into; the test seeds and inspects it. */
export interface GhState {
	repo: string;
	/** Pull requests associated with a commit. */
	pulls: Record<string, PullJson[]>;
	/** Tag name -> commit. */
	tags: Record<string, string>;
	/** Tag name -> the release created for it. */
	releases: Record<string, { title: string; notes: string }>;
	/** Call names that fail once, then succeed: `pulls <sha>`, `tag <tag>`, `create-tag <tag>`, `release <tag>`, `release-create <tag>`. */
	failOnce: string[];
	/** Every call in order, by the same names. */
	calls: string[];
}

/**
 * A `gh` executable for `src/github.ts`: `gh api --include` for commit pulls, tag refs, tag creation,
 * and release lookup, and `gh release create`, which refuses an unknown tag as `--verify-tag` does.
 * It runs under Node from a temporary directory; the repository holds no JavaScript sources.
 */
const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.GH_STUB_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, "\t"));
const fail = (message) => {
	save();
	fs.writeSync(2, message + "\n");
	process.exit(1);
};
const call = (name) => {
	state.calls.push(name);
	const index = state.failOnce.indexOf(name);
	if (index >= 0) {
		state.failOnce.splice(index, 1);
		fail("gh stub: " + name + " failed");
	}
};
const respond = (status, data) => {
	save();
	fs.writeSync(1, "HTTP/2.0 " + status + " " + (status < 400 ? "OK" : "Error") + "\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify(data));
	process.exit(status < 400 ? 0 : 1);
};
if (args[0] === "api") {
	let method = "GET";
	let path = "";
	const fields = {};
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--include") continue;
		if (args[i] === "--method") method = args[++i];
		else if (args[i] === "-f") {
			const [key, ...value] = args[++i].split("=");
			fields[key] = value.join("=");
		} else path = args[i];
	}
	const prefix = "repos/" + state.repo + "/";
	const rest = path.startsWith(prefix) ? path.slice(prefix.length) : "";
	let match;
	if ((match = /^commits\/([0-9a-f]+)\/pulls$/.exec(rest))) {
		call("pulls " + match[1]);
		respond(200, state.pulls[match[1]] ?? []);
	}
	if ((match = /^git\/ref\/tags\/(.+)$/.exec(rest))) {
		const tag = decodeURIComponent(match[1]);
		call("tag " + tag);
		const sha = state.tags[tag];
		if (sha === undefined) respond(404, { message: "Not Found" });
		respond(200, { ref: "refs/tags/" + tag, object: { type: "commit", sha } });
	}
	if (rest === "git/refs" && method === "POST") {
		const tag = String(fields.ref).replace(/^refs\/tags\//, "");
		call("create-tag " + tag);
		if (state.tags[tag] !== undefined) respond(422, { message: "Reference already exists" });
		state.tags[tag] = fields.sha;
		respond(201, { ref: fields.ref, object: { type: "commit", sha: fields.sha } });
	}
	if ((match = /^releases\/tags\/(.+)$/.exec(rest))) {
		const tag = decodeURIComponent(match[1]);
		call("release " + tag);
		if (state.releases[tag] === undefined) respond(404, { message: "Not Found" });
		respond(200, { tag_name: tag });
	}
	respond(404, { message: "Not Found" });
}
if (args[0] === "release" && args[1] === "create") {
	const tag = args[2];
	const option = (name) => {
		const index = args.indexOf(name);
		return index < 0 ? undefined : args[index + 1];
	};
	call("release-create " + tag);
	if (option("--repo") !== state.repo) fail("gh stub: unexpected --repo " + option("--repo"));
	if (args.includes("--verify-tag") && state.tags[tag] === undefined) fail("tag " + tag + " doesn't exist in the repo");
	if (state.releases[tag] !== undefined) fail("a release with the same tag name already exists: " + tag);
	state.releases[tag] = { title: option("--title"), notes: fs.readFileSync(option("--notes-file"), "utf8") };
	save();
	process.exit(0);
}
fail("gh stub: unsupported call: " + args.join(" "));
`;

export class GhStub {
	readonly #file: string;

	private constructor(file: string) {
		this.#file = file;
	}

	/** Writes the executable into `bin` and its empty state next to it. */
	static async create(bin: string, repo: string): Promise<GhStub> {
		await writeFile(join(bin, "gh"), SCRIPT, { mode: 0o755 });
		const stub = new GhStub(join(bin, "gh-state.json"));
		await stub.write({ repo, pulls: {}, tags: {}, releases: {}, failOnce: [], calls: [] });
		return stub;
	}

	/** The environment variable that points the executable at its state. */
	get env(): Record<string, string> {
		return { GH_STUB_STATE: this.#file };
	}

	async read(): Promise<GhState> {
		return JSON.parse(await readFile(this.#file, "utf8"));
	}

	async write(state: GhState): Promise<void> {
		await writeFile(this.#file, JSON.stringify(state, null, "\t"));
	}

	async update(change: (state: GhState) => void): Promise<GhState> {
		const state = await this.read();
		change(state);
		await this.write(state);
		return state;
	}

	/** Records `sha` as the squash or merge commit of merged pull request `number` into `master`. */
	merged(sha: string, number: number): Promise<GhState> {
		return this.update((state) => {
			state.pulls[sha] = [
				{ number, merged_at: "2026-10-01T00:00:00Z", merge_commit_sha: sha, base: { ref: "master" } },
			];
		});
	}
}
