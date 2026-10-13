import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PreparedMember } from "./batch.ts";
import { errorMessage, field, ReleaseError } from "./errors.ts";
import type { VersionLookup } from "./registry.ts";

/** Written by `verify` next to the validated tarballs; `publish` accepts nothing else. */
export const BATCH_FILE = "batch.json";

export interface BatchFileEntry {
	readonly key: string;
	readonly file: string;
	readonly sha256: string;
}

export interface BatchFile {
	readonly source: string;
	readonly members: readonly BatchFileEntry[];
}

export interface Artifact {
	readonly member: PreparedMember;
	readonly tarball: string;
}

/** Registry, upload, and GitHub effects of publication; tests substitute small doubles. */
export interface PublishEffects {
	lookupVersion(name: string, version: string): Promise<VersionLookup>;
	tarballAvailable(url: string): Promise<boolean>;
	/** Uploads a validated tarball and waits for registry availability; throws on any failure. */
	upload(tarball: string): Promise<void>;
	tagTarget(tag: string): Promise<string | undefined>;
	createTag(tag: string, sha: string): Promise<void>;
	releaseExists(tag: string): Promise<boolean>;
	createRelease(tag: string, notes: string): Promise<void>;
}

export type UploadState = "uploaded" | "already-published" | "failed" | "not-attempted";
export type RecordState = "created" | "existing" | "failed" | "not-attempted";

export interface MemberReport {
	readonly key: string;
	readonly upload: UploadState;
	readonly tag: RecordState;
	readonly release: RecordState;
	readonly problems: readonly string[];
}

export function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function parseBatchFile(text: string): BatchFile {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new ReleaseError(`${BATCH_FILE}: invalid JSON: ${errorMessage(error)}`);
	}
	const source = field(data, "source");
	const members = field(data, "members");
	if (typeof source !== "string" || !Array.isArray(members)) {
		throw new ReleaseError(`${BATCH_FILE}: expected { source, members }`);
	}
	return {
		source,
		members: members.map((entry: unknown) => {
			const key = field(entry, "key");
			const file = field(entry, "file");
			const hash = field(entry, "sha256");
			if (typeof key !== "string" || typeof file !== "string" || typeof hash !== "string" || basename(file) !== file) {
				throw new ReleaseError(`${BATCH_FILE}: malformed member entry`);
			}
			return { key, file, sha256: hash };
		}),
	};
}

/**
 * Pairs every member of the freshly derived batch with exactly one validated tarball. A missing,
 * extra, or altered artifact stops publication before any upload.
 */
export async function loadArtifacts(
	dir: string,
	source: string,
	members: readonly PreparedMember[],
): Promise<Artifact[]> {
	let text: string;
	try {
		text = await readFile(join(dir, BATCH_FILE), "utf8");
	} catch (error) {
		throw new ReleaseError(`no verified batch in ${dir} (${errorMessage(error)}); artifact preflight must pass first`);
	}
	const batch = parseBatchFile(text);
	const problems: string[] = [];
	if (batch.source !== source) {
		problems.push(`the artifacts were verified for ${batch.source}, not ${source}`);
	}
	const byKey = new Map(batch.members.map((entry) => [entry.key, entry]));
	const extra = batch.members.filter((entry) => !members.some((member) => member.key === entry.key));
	if (extra.length > 0 || byKey.size !== batch.members.length) {
		problems.push(
			`unexpected or duplicate artifacts: ${extra.map((entry) => entry.key).join(", ") || "duplicate keys"}`,
		);
	}
	const artifacts: Artifact[] = [];
	for (const member of members) {
		const entry = byKey.get(member.key);
		if (entry === undefined) {
			problems.push(`${member.key}: no verified artifact`);
			continue;
		}
		const tarball = join(dir, entry.file);
		try {
			if (sha256(await readFile(tarball)) !== entry.sha256) {
				problems.push(`${member.key}: ${entry.file} differs from the verified artifact`);
			}
		} catch (error) {
			problems.push(`${member.key}: ${errorMessage(error)}`);
		}
		artifacts.push({ member, tarball });
	}
	if (problems.length > 0) {
		throw new ReleaseError(
			`the verified artifacts do not match the batch; nothing was uploaded:\n${problems.join("\n")}`,
		);
	}
	return artifacts;
}

interface MutableReport {
	key: string;
	upload: UploadState;
	tag: RecordState;
	release: RecordState;
	problems: string[];
}

/**
 * Publishes one fixed batch from its release commit. Each exact version already on the registry is
 * skipped (once its tarball is served); a missing one is uploaded from its validated artifact. The
 * first upload-phase failure stops further uploads. Every available member then gets its tag at the
 * release commit and its GitHub Release from the committed notes; existing ones are left alone and
 * a tag pointing elsewhere is an error, never moved.
 */
export async function publishBatch(
	sourceSha: string,
	artifacts: readonly Artifact[],
	effects: PublishEffects,
): Promise<MemberReport[]> {
	const entries = artifacts.map((artifact) => {
		const report: MutableReport = {
			key: artifact.member.key,
			upload: "not-attempted",
			tag: "not-attempted",
			release: "not-attempted",
			problems: [],
		};
		return { artifact, report };
	});
	for (const { artifact, report } of entries) {
		const { key, name, version } = artifact.member;
		try {
			const lookup = await effects.lookupVersion(name, version);
			if (lookup.kind === "found") {
				if (!(await effects.tarballAvailable(lookup.tarball))) {
					throw new ReleaseError(`${key} is on the registry but its tarball is not served yet; rerun later`);
				}
				report.upload = "already-published";
			} else {
				await effects.upload(artifact.tarball);
				report.upload = "uploaded";
			}
		} catch (error) {
			report.upload = "failed";
			report.problems.push(errorMessage(error));
			break;
		}
	}
	for (const { artifact, report } of entries) {
		if (report.upload !== "uploaded" && report.upload !== "already-published") {
			continue;
		}
		const tag = artifact.member.key;
		try {
			const target = await effects.tagTarget(tag);
			if (target === undefined) {
				await effects.createTag(tag, sourceSha);
				report.tag = "created";
			} else if (target === sourceSha) {
				report.tag = "existing";
			} else {
				throw new ReleaseError(
					`tag ${tag} points to ${target}, not the release commit ${sourceSha}; tags are never moved`,
				);
			}
			if (await effects.releaseExists(tag)) {
				report.release = "existing";
			} else {
				await effects.createRelease(tag, artifact.member.notes);
				report.release = "created";
			}
		} catch (error) {
			if (report.tag === "not-attempted") {
				report.tag = "failed";
			} else {
				report.release = "failed";
			}
			report.problems.push(errorMessage(error));
		}
	}
	return entries.map(({ report }) => report);
}

export function batchComplete(reports: readonly MemberReport[]): boolean {
	return reports.every(
		(report) =>
			(report.upload === "uploaded" || report.upload === "already-published") &&
			(report.tag === "created" || report.tag === "existing") &&
			(report.release === "created" || report.release === "existing"),
	);
}
