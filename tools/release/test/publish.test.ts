import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedMember } from "../src/batch.ts";
import {
	type Artifact,
	BATCH_FILE,
	batchComplete,
	loadArtifacts,
	type PublishEffects,
	publishBatch,
	sha256,
} from "../src/publish.ts";
import type { VersionLookup } from "../src/registry.ts";

const SOURCE = "a".repeat(40);

function member(name: string, version: string): PreparedMember {
	const dirName = name.slice(name.indexOf("/") + 1);
	return {
		key: `${name}@${version}`,
		name,
		version,
		dirName,
		record: { dir: `packages/${dirName}`, intents: ["x"] },
		notes: `Notes of ${name}@${version}`,
	};
}

const A = member("@zeroclover/pi-a", "0.1.2");
const B = member("@zeroclover/pi-b", "2.1.3");
const artifacts: Artifact[] = [
	{ member: A, tarball: "/out/a.tgz" },
	{ member: B, tarball: "/out/b.tgz" },
];

interface World {
	published: Map<string, boolean>;
	tags: Map<string, string>;
	releases: Set<string>;
	failures: Partial<Record<string, string>>;
}

/** A small double of the registry and GitHub that records the calls the publisher makes. */
function doubles(world: Partial<World> = {}): { effects: PublishEffects; calls: string[] } {
	const state: World = {
		published: world.published ?? new Map(),
		tags: world.tags ?? new Map(),
		releases: world.releases ?? new Set(),
		failures: world.failures ?? {},
	};
	const calls: string[] = [];
	const step = (call: string): void => {
		calls.push(call);
		const failure = state.failures[call];
		if (failure !== undefined) {
			throw new Error(failure);
		}
	};
	const effects: PublishEffects = {
		async lookupVersion(name, version): Promise<VersionLookup> {
			step(`lookup ${name}@${version}`);
			const available = state.published.get(`${name}@${version}`);
			return available === undefined
				? { kind: "missing" }
				: { kind: "found", tarball: `https://registry/${name}@${version}.tgz` };
		},
		async tarballAvailable(url) {
			step(`head ${url}`);
			const key = url.slice("https://registry/".length, -".tgz".length);
			return state.published.get(key) === true;
		},
		async upload(tarball) {
			step(`upload ${tarball}`);
		},
		async tagTarget(tag) {
			step(`tag? ${tag}`);
			return state.tags.get(tag);
		},
		async createTag(tag, sha) {
			step(`tag ${tag} ${sha.slice(0, 7)}`);
			state.tags.set(tag, sha);
		},
		async releaseExists(tag) {
			step(`release? ${tag}`);
			return state.releases.has(tag);
		},
		async createRelease(tag, notes) {
			step(`release ${tag}: ${notes}`);
			state.releases.add(tag);
		},
	};
	return { effects, calls };
}

describe("publishBatch", () => {
	it("uploads missing versions, then tags the release commit and announces from the committed notes", async () => {
		const { effects, calls } = doubles();
		const reports = await publishBatch(SOURCE, artifacts, effects);
		expect(calls).toEqual([
			"lookup @zeroclover/pi-a@0.1.2",
			"upload /out/a.tgz",
			"lookup @zeroclover/pi-b@2.1.3",
			"upload /out/b.tgz",
			"tag? @zeroclover/pi-a@0.1.2",
			"tag @zeroclover/pi-a@0.1.2 aaaaaaa",
			"release? @zeroclover/pi-a@0.1.2",
			"release @zeroclover/pi-a@0.1.2: Notes of @zeroclover/pi-a@0.1.2",
			"tag? @zeroclover/pi-b@2.1.3",
			"tag @zeroclover/pi-b@2.1.3 aaaaaaa",
			"release? @zeroclover/pi-b@2.1.3",
			"release @zeroclover/pi-b@2.1.3: Notes of @zeroclover/pi-b@2.1.3",
		]);
		expect(batchComplete(reports)).toBe(true);
	});

	it("skips exact versions that are already available and only fills in missing announcements", async () => {
		const { effects, calls } = doubles({
			published: new Map([
				[A.key, true],
				[B.key, true],
			]),
			tags: new Map([[A.key, SOURCE]]),
			releases: new Set([A.key]),
		});
		const reports = await publishBatch(SOURCE, artifacts, effects);
		expect(calls.filter((call) => call.startsWith("upload"))).toEqual([]);
		expect(calls).toContain("release @zeroclover/pi-b@2.1.3: Notes of @zeroclover/pi-b@2.1.3");
		expect(reports.map((report) => [report.upload, report.tag, report.release])).toEqual([
			["already-published", "existing", "existing"],
			["already-published", "created", "created"],
		]);
	});

	it("stops when an existing version's tarball is not served yet", async () => {
		const { effects, calls } = doubles({ published: new Map([[A.key, false]]) });
		const reports = await publishBatch(SOURCE, artifacts, effects);
		expect(calls).toEqual(["lookup @zeroclover/pi-a@0.1.2", "head https://registry/@zeroclover/pi-a@0.1.2.tgz"]);
		expect(reports.map((report) => report.upload)).toEqual(["failed", "not-attempted"]);
		expect(batchComplete(reports)).toBe(false);
	});

	it("stops all uploads on a lookup error instead of treating it as absence", async () => {
		const { effects, calls } = doubles({ failures: { "lookup @zeroclover/pi-a@0.1.2": "HTTP 401" } });
		const reports = await publishBatch(SOURCE, artifacts, effects);
		expect(calls).toEqual(["lookup @zeroclover/pi-a@0.1.2"]);
		expect(reports[0]?.problems).toEqual(["HTTP 401"]);
	});

	it("reports partial success per package and still announces the published one", async () => {
		const { effects, calls } = doubles({ failures: { "upload /out/b.tgz": "E403" } });
		const reports = await publishBatch(SOURCE, artifacts, effects);
		expect(reports.map((report) => [report.key, report.upload, report.tag, report.release])).toEqual([
			[A.key, "uploaded", "created", "created"],
			[B.key, "failed", "not-attempted", "not-attempted"],
		]);
		expect(calls.some((call) => call.startsWith("tag? @zeroclover/pi-b"))).toBe(false);
	});

	it("retries the original batch: A already published, B uploaded, both announced at the release commit", async () => {
		const { effects, calls } = doubles({ published: new Map([[A.key, true]]) });
		const reports = await publishBatch(SOURCE, artifacts, effects);
		expect(calls.filter((call) => call.startsWith("upload"))).toEqual(["upload /out/b.tgz"]);
		expect(calls.filter((call) => call.startsWith("tag @"))).toEqual([
			"tag @zeroclover/pi-a@0.1.2 aaaaaaa",
			"tag @zeroclover/pi-b@2.1.3 aaaaaaa",
		]);
		expect(batchComplete(reports)).toBe(true);
	});

	it("never moves a tag that points elsewhere", async () => {
		const { effects, calls } = doubles({
			published: new Map([[A.key, true]]),
			tags: new Map([[A.key, "b".repeat(40)]]),
		});
		const reports = await publishBatch(SOURCE, [artifacts[0] as Artifact], effects);
		expect(calls.some((call) => call.startsWith("tag @"))).toBe(false);
		expect(reports[0]?.tag).toBe("failed");
		expect(reports[0]?.problems[0]).toMatch(/tags are never moved/);
	});

	it("fails on tag and release lookup errors instead of creating replacements", async () => {
		const tagError = doubles({
			published: new Map([[A.key, true]]),
			failures: { "tag? @zeroclover/pi-a@0.1.2": "HTTP 500" },
		});
		const tagReport = await publishBatch(SOURCE, [artifacts[0] as Artifact], tagError.effects);
		expect([tagReport[0]?.tag, tagReport[0]?.release]).toEqual(["failed", "not-attempted"]);
		expect(tagError.calls.some((call) => call.startsWith("tag @"))).toBe(false);

		const releaseError = doubles({
			published: new Map([[A.key, true]]),
			tags: new Map([[A.key, SOURCE]]),
			failures: { "release? @zeroclover/pi-a@0.1.2": "HTTP 502" },
		});
		const releaseReport = await publishBatch(SOURCE, [artifacts[0] as Artifact], releaseError.effects);
		expect([releaseReport[0]?.tag, releaseReport[0]?.release]).toEqual(["existing", "failed"]);
		expect(releaseError.calls.some((call) => call.startsWith("release @"))).toBe(false);
	});
});

describe("loadArtifacts", () => {
	let dir = "";
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function setup(
		entries: readonly { key: string; file: string; content: string }[],
		source = SOURCE,
	): Promise<void> {
		dir = await mkdtemp(join(tmpdir(), "release-artifacts-"));
		for (const entry of entries) {
			await writeFile(join(dir, entry.file), entry.content);
		}
		const members = entries.map(({ key, file, content }) => ({ key, file, sha256: sha256(Buffer.from(content)) }));
		await writeFile(join(dir, BATCH_FILE), JSON.stringify({ source, members }));
	}

	it("pairs every batch member with its verified tarball", async () => {
		await setup([
			{ key: A.key, file: "a.tgz", content: "A" },
			{ key: B.key, file: "b.tgz", content: "B" },
		]);
		const loaded = await loadArtifacts(dir, SOURCE, [A, B]);
		expect(loaded.map((artifact) => artifact.tarball)).toEqual([join(dir, "a.tgz"), join(dir, "b.tgz")]);
	});

	it("blocks the whole batch when one member was not verified", async () => {
		await setup([{ key: A.key, file: "a.tgz", content: "A" }]);
		await expect(loadArtifacts(dir, SOURCE, [A, B])).rejects.toThrow(/@zeroclover\/pi-b@2.1.3: no verified artifact/);
	});

	it("refuses to publish without a verified batch", async () => {
		dir = await mkdtemp(join(tmpdir(), "release-artifacts-"));
		await expect(loadArtifacts(dir, SOURCE, [A])).rejects.toThrow(/no verified batch/);
	});

	it("rejects altered tarballs, extra artifacts, and another source commit", async () => {
		await setup([
			{ key: A.key, file: "a.tgz", content: "A" },
			{ key: "@zeroclover/pi-c@1.0.0", file: "c.tgz", content: "C" },
		]);
		await writeFile(join(dir, "a.tgz"), "tampered");
		await expect(loadArtifacts(dir, "b".repeat(40), [A])).rejects.toThrow(
			/verified for a+, not b+[\s\S]*unexpected or duplicate artifacts: @zeroclover\/pi-c@1.0.0[\s\S]*differs from the verified artifact/,
		);
	});
});
