import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	CALIBRATION_ALPHA,
	CALIBRATION_MAX_OUTPUT_RATIO,
	CALIBRATION_MAX_THINKING_RATIO,
	CALIBRATION_MIN_ESTIMATE,
	CALIBRATION_MIN_RATIO,
} from "./constants.ts";
import { errorMessage, type FileLayer } from "./files.ts";

/** Directory of the calibration versions inside Pi's agent directory. */
export const CALIBRATION_DIR_NAME = "pi-tps-calibration";

/**
 * The token kinds calibrated separately: visible output (text and tool calls) and thinking. The output ratio is near 1
 * for every model, the thinking ratio only for models that stream their full chain of thought.
 */
export type CalibrationKind = "output" | "thinking";

export const CALIBRATION_KINDS: readonly CalibrationKind[] = ["output", "thinking"];

export interface RatioEntry {
	ratio: number;
	samples: number;
	/** Wall-clock milliseconds of the last update. */
	updatedAt: number;
}

/** The ratios of one model; each kind is present once a sample of that kind was applied. */
export interface CalibrationEntry {
	output?: RatioEntry;
	thinking?: RatioEntry;
}

/** The factors a live estimate of a model is multiplied by; absent when that kind is not calibrated yet. */
export interface CalibrationRatios {
	output?: number | undefined;
	thinking?: number | undefined;
}

/** One request's reported tokens of one kind and the raw estimate for the same tokens. */
export interface CalibrationSample {
	reported: number;
	estimated: number;
}

/** Per session: the highest sample number applied, and when the session last published. */
export interface WriterRecord {
	seq: number;
	at: number;
}

const FILE_VERSION = 2;

interface CalibrationFile {
	version: typeof FILE_VERSION;
	models: Record<string, CalibrationEntry>;
	writers: Record<string, WriterRecord>;
}

export function calibrationKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

/**
 * Keys a sample is stored under: the response model the provider reported, and the requested model, because a
 * new request only knows the requested model when it looks up its ratio.
 */
export function calibrationKeys(provider: string, model: string, responseModel?: string): string[] {
	const keys = [calibrationKey(provider, responseModel ?? model)];
	if (responseModel !== undefined && responseModel !== model) keys.push(calibrationKey(provider, model));
	return keys;
}

export function clampRatio(kind: CalibrationKind, ratio: number): number {
	const max = kind === "output" ? CALIBRATION_MAX_OUTPUT_RATIO : CALIBRATION_MAX_THINKING_RATIO;
	return Math.min(max, Math.max(CALIBRATION_MIN_RATIO, ratio));
}

/** Tiny responses carry too much rounding noise to learn from. */
export function isCalibratable(sample: CalibrationSample): boolean {
	return (
		Number.isFinite(sample.reported) &&
		sample.reported > 0 &&
		Number.isFinite(sample.estimated) &&
		sample.estimated > CALIBRATION_MIN_ESTIMATE
	);
}

/** Exponential moving average of `reported / estimated`; the first sample sets the ratio directly. */
export function nextRatio(
	kind: CalibrationKind,
	previous: RatioEntry | undefined,
	sample: CalibrationSample,
	now: number,
): RatioEntry {
	const observed = clampRatio(kind, sample.reported / sample.estimated);
	if (!previous) return { ratio: observed, samples: 1, updatedAt: now };
	const ratio = clampRatio(kind, previous.ratio + CALIBRATION_ALPHA * (observed - previous.ratio));
	return { ratio, samples: previous.samples + 1, updatedAt: now };
}

/** The model entry after one sample of one kind; the other kind is unchanged. */
export function nextEntry(
	previous: CalibrationEntry | undefined,
	kind: CalibrationKind,
	sample: CalibrationSample,
	now: number,
): CalibrationEntry {
	const entry: CalibrationEntry = { ...previous };
	entry[kind] = nextRatio(kind, previous?.[kind], sample, now);
	return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRatio(kind: CalibrationKind, value: unknown): RatioEntry | undefined {
	if (!isRecord(value)) return undefined;
	const { ratio, samples, updatedAt } = value;
	if (typeof ratio !== "number" || !Number.isFinite(ratio)) return undefined;
	if (typeof samples !== "number" || !Number.isInteger(samples) || samples < 1) return undefined;
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
	return { ratio: clampRatio(kind, ratio), samples, updatedAt };
}

/** A model entry with at least one valid ratio and no invalid one. */
function parseEntry(value: unknown): CalibrationEntry | undefined {
	if (!isRecord(value)) return undefined;
	const entry: CalibrationEntry = {};
	for (const kind of CALIBRATION_KINDS) {
		if (value[kind] === undefined) continue;
		const ratio = parseRatio(kind, value[kind]);
		if (!ratio) return undefined;
		entry[kind] = ratio;
	}
	return entry.output || entry.thinking ? entry : undefined;
}

const UNSUPPORTED_FORMAT = `unsupported format, expected { version: ${FILE_VERSION}, models: {...} }`;

function parseWriter(value: unknown): WriterRecord | undefined {
	if (!isRecord(value)) return undefined;
	const { seq, at } = value;
	if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return undefined;
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
	return { seq, at };
}

/**
 * One parsed calibration version: `current` with its models (individual invalid entries skipped with a warning),
 * `other-format` for a file of another format version, or `invalid` when the content cannot be used at all.
 */
export type ParsedCalibration =
	| {
			status: "current";
			models: Map<string, CalibrationEntry>;
			writers: Map<string, WriterRecord>;
			warning?: string;
	  }
	| { status: "other-format" }
	| { status: "invalid"; warning: string };

export function parseCalibration(text: string): ParsedCalibration {
	const models = new Map<string, CalibrationEntry>();
	const writers = new Map<string, WriterRecord>();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return { status: "invalid", warning: `invalid JSON (${errorMessage(error)})` };
	}
	if (!isRecord(json)) return { status: "invalid", warning: UNSUPPORTED_FORMAT };
	const { version, models: entries, writers: records } = json;
	// Files of an older (or newer) format are not migrated: calibration starts over.
	if (typeof version === "number" && version !== FILE_VERSION) return { status: "other-format" };
	if (version !== FILE_VERSION || !isRecord(entries)) return { status: "invalid", warning: UNSUPPORTED_FORMAT };
	if (isRecord(records)) {
		for (const [id, value] of Object.entries(records)) {
			const record = parseWriter(value);
			if (record) writers.set(id, record);
		}
	}
	let skipped = 0;
	for (const [key, value] of Object.entries(entries)) {
		const entry = parseEntry(value);
		if (entry) models.set(key, entry);
		else skipped++;
	}
	if (skipped === 0) return { status: "current", models, writers };
	return {
		status: "current",
		models,
		writers,
		warning: `skipped ${skipped} invalid entr${skipped === 1 ? "y" : "ies"}`,
	};
}

const VERSION_NAME = /^(\d{10})\.json$/;
/** Versions kept after a publish, so a reader that listed the directory a moment ago still finds its file. */
const KEPT_VERSIONS = 3;
/** Publish rounds per flush; each failed round means another session published in between. */
const PUBLISH_ATTEMPTS = 5;
const DAY_MS = 86_400_000;
/** Records of sessions that have not published for this long are removed; only crashed sessions leave them. */
export const WRITER_RETENTION_MS = 7 * DAY_MS;
/**
 * A session whose own record vanished treats its unconfirmed samples as possibly applied once its last creation is
 * this old: one day earlier than other sessions may remove the record, as a margin for clock differences.
 */
const UNPROVABLE_AFTER_MS = WRITER_RETENTION_MS - DAY_MS;

function versionName(version: number): string {
	return `${String(version).padStart(10, "0")}.json`;
}

interface PendingSample {
	/** Position in this session's sample order, from 1. */
	seq: number;
	key: string;
	kind: CalibrationKind;
	sample: CalibrationSample;
	at: number;
}

interface Snapshot {
	/** Highest version number present, also when its file is unusable, so the next publish goes past it. */
	version: number;
	models: Map<string, CalibrationEntry>;
	writers: Map<string, WriterRecord>;
	warning?: string;
}

function replay(base: ReadonlyMap<string, CalibrationEntry>, samples: readonly PendingSample[]) {
	const models = new Map(base);
	for (const { key, kind, sample, at } of samples) models.set(key, nextEntry(models.get(key), kind, sample, at));
	return models;
}

/**
 * Calibration ratios per `<provider>/<model>`, shared by every Pi session through numbered versions in one
 * directory. An update publishes the next version, derived from the newest one, with an exclusive and atomic file
 * creation. Because old versions are removed, a number can become free again and a session that paused can create a
 * stale version below the real newest one, so a creation proves nothing. Instead each session numbers its samples
 * in order, and every version records per session the highest number applied (`writers`), carried into every
 * version derived from it: a sample is stored exactly when the newest version records its number. Until then it
 * stays pending, applied once on top of the newest version for this session's ratios, and retried. No lock is
 * needed.
 *
 * Methods return warning texts instead of reporting them so the caller can use the context of its event.
 */
export class CalibrationStore {
	private readonly writer = randomUUID();
	private nextSeq = 1;
	/** Highest sample number contained in a file this session created, and when it created it. */
	private createdUpTo = 0;
	private createdAt = 0;
	private published = new Map<string, CalibrationEntry>();
	private pending: PendingSample[] = [];
	private models = new Map<string, CalibrationEntry>();
	private writeWarned = false;

	constructor(
		private readonly dir: string,
		private readonly files: FileLayer,
		private readonly clock: () => number = Date.now,
	) {}

	/** Reads the newest version. A missing directory is an empty store. */
	load(): string | undefined {
		this.pending = [];
		let snapshot: Snapshot;
		try {
			snapshot = this.readNewest();
		} catch (error) {
			this.published = new Map();
			this.models = new Map();
			return `pi-tps: cannot read ${this.dir}: ${errorMessage(error)}; calibration starts empty`;
		}
		this.published = snapshot.models;
		this.models = new Map(snapshot.models);
		return snapshot.warning === undefined ? undefined : `pi-tps: ${snapshot.warning}`;
	}

	ratios(key: string): CalibrationRatios {
		const entry = this.models.get(key);
		return { output: entry?.output?.ratio, thinking: entry?.thinking?.ratio };
	}

	entry(key: string): CalibrationEntry | undefined {
		return this.models.get(key);
	}

	/** Applies one sample of one kind and publishes it. Returns a warning the first time writing fails. */
	update(key: string, kind: CalibrationKind, sample: CalibrationSample, now: number): string | undefined {
		if (!isCalibratable(sample)) return undefined;
		this.pending.push({ seq: this.nextSeq++, key, kind, sample, at: now });
		this.models = replay(this.published, this.pending);
		return this.flush();
	}

	/**
	 * Stores the pending samples on top of the newest version; called after each update. Each round reads the newest
	 * version, drops the samples its record for this session covers, and publishes the rest as the next version; the
	 * following round's read is the check.
	 */
	flush(): string | undefined {
		for (let round = 0; this.pending.length > 0; round++) {
			let snapshot: Snapshot;
			try {
				snapshot = this.readNewest();
			} catch (error) {
				return this.writeFailure(error);
			}
			this.settlePending(snapshot);
			if (this.pending.length === 0 || round === PUBLISH_ATTEMPTS) break;
			const last = this.pending.at(-1);
			if (!last) break;
			const now = this.clock();
			const writers = this.liveWriters(snapshot, now);
			writers.set(this.writer, { seq: last.seq, at: now });
			try {
				this.publish(snapshot, this.models, writers, () => {
					this.createdUpTo = last.seq;
					this.createdAt = now;
				});
			} catch (error) {
				return this.writeFailure(error);
			}
		}
		return undefined;
	}

	/**
	 * Ends the session: stores what it can, then removes this session's record, which nothing will need again.
	 * Called at session shutdown.
	 */
	close(): string | undefined {
		const warning = this.flush();
		for (let round = 0; round <= PUBLISH_ATTEMPTS; round++) {
			let snapshot: Snapshot;
			try {
				snapshot = this.readNewest();
			} catch (error) {
				return warning ?? this.writeFailure(error);
			}
			if (!snapshot.writers.has(this.writer) || round === PUBLISH_ATTEMPTS) break;
			const writers = this.liveWriters(snapshot, this.clock());
			writers.delete(this.writer);
			try {
				// Removing the record carries no samples, so a possible creation needs no note.
				this.publish(snapshot, snapshot.models, writers, () => {});
			} catch (error) {
				return warning ?? this.writeFailure(error);
			}
		}
		return warning;
	}

	/** Drops pending samples the newest version already holds, or whose storage can no longer be proven. */
	private settlePending(snapshot: Snapshot): void {
		const record = snapshot.writers.get(this.writer);
		if (record) {
			this.pending = this.pending.filter((sample) => sample.seq > record.seq);
		} else if (this.createdUpTo > 0 && this.clock() - this.createdAt > UNPROVABLE_AFTER_MS) {
			// The record may have been removed after holding these samples; applying them again could count them twice.
			const createdUpTo = this.createdUpTo;
			this.pending = this.pending.filter((sample) => sample.seq > createdUpTo);
		}
		this.published = snapshot.models;
		this.models = replay(snapshot.models, this.pending);
	}

	/** The snapshot's session records without those of sessions gone for longer than the retention. */
	private liveWriters(snapshot: Snapshot, now: number): Map<string, WriterRecord> {
		const writers = new Map<string, WriterRecord>();
		for (const [id, record] of snapshot.writers) {
			if (now - record.at <= WRITER_RETENTION_MS) writers.set(id, record);
		}
		return writers;
	}

	/**
	 * Creates the version after the snapshot's and then removes old versions; true when the file was created (which
	 * proves nothing more). `notePossibleCreation` runs as soon as the file may exist: when the creation reports
	 * success, before the cleanup that can still fail, and when the creation throws, since the file can exist although
	 * the call failed.
	 */
	private publish(
		snapshot: Snapshot,
		models: ReadonlyMap<string, CalibrationEntry>,
		writers: ReadonlyMap<string, WriterRecord>,
		notePossibleCreation: () => void,
	): boolean {
		const file: CalibrationFile = {
			version: FILE_VERSION,
			models: Object.fromEntries(models),
			writers: Object.fromEntries(writers),
		};
		const version = snapshot.version + 1;
		let created: boolean;
		try {
			created = this.files.publish(this.path(version), `${JSON.stringify(file, null, "\t")}\n`);
		} catch (error) {
			notePossibleCreation();
			throw error;
		}
		if (!created) return false;
		notePossibleCreation();
		this.prune(version);
		return true;
	}

	private path(version: number): string {
		return join(this.dir, versionName(version));
	}

	private versions(): number[] {
		return this.files
			.list(this.dir)
			.flatMap((name) => {
				const match = VERSION_NAME.exec(name);
				return match?.[1] === undefined ? [] : [Number(match[1])];
			})
			.sort((a, b) => b - a);
	}

	/**
	 * The newest usable version; invalid newer files are reported and skipped. A version in another file format ends
	 * the search: the calibration starts empty and the next publish goes past it.
	 */
	private readNewest(): Snapshot {
		const versions = this.versions();
		const highest = versions[0] ?? 0;
		let warning: string | undefined;
		let snapshot: Snapshot = { version: highest, models: new Map(), writers: new Map() };
		for (const version of versions) {
			const text = this.files.read(this.path(version));
			// Removed by another session between listing and reading; an older version follows.
			if (text === undefined) continue;
			const parsed = parseCalibration(text);
			if (parsed.status === "other-format") break;
			if (parsed.warning !== undefined) warning ??= `${this.path(version)}: ${parsed.warning}`;
			if (parsed.status === "invalid") continue;
			snapshot = { version: highest, models: parsed.models, writers: parsed.writers };
			break;
		}
		if (warning !== undefined) snapshot.warning = warning;
		return snapshot;
	}

	private prune(newest: number): void {
		for (const version of this.versions()) {
			if (version <= newest - KEPT_VERSIONS) this.files.remove(this.path(version));
		}
	}

	private writeFailure(error: unknown): string | undefined {
		if (this.writeWarned) return undefined;
		this.writeWarned = true;
		return `pi-tps: cannot write ${this.dir}: ${errorMessage(error)}; calibration is kept for this session and retried`;
	}
}

/** What a session reads and writes of the calibration; {@link CalibrationStore} is the enabled form. */
export interface SessionCalibration {
	ratios(key: string): CalibrationRatios;
	update(key: string, kind: CalibrationKind, sample: CalibrationSample, now: number): string | undefined;
	close(): string | undefined;
}

/** Disabled calibration: every factor is 1, and nothing is read, written or warned about. */
const NO_CALIBRATION: SessionCalibration = {
	ratios: () => ({}),
	update: () => undefined,
	close: () => undefined,
};

/** Opens the calibration of a session, loading the newest version only when calibration is enabled. */
export function openCalibration(
	enabled: boolean,
	dir: string,
	files: FileLayer,
): { calibration: SessionCalibration; warning?: string } {
	if (!enabled) return { calibration: NO_CALIBRATION };
	const store = new CalibrationStore(dir, files);
	const warning = store.load();
	return warning === undefined ? { calibration: store } : { calibration: store, warning };
}
