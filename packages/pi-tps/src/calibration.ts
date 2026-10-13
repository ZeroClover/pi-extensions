import { join } from "node:path";
import {
	CALIBRATION_ALPHA,
	CALIBRATION_MAX_RATIO,
	CALIBRATION_MIN_ESTIMATE,
	CALIBRATION_MIN_RATIO,
} from "./constants.ts";
import { errorMessage, type FileLayer } from "./files.ts";

/** Directory of the calibration versions inside Pi's agent directory. */
export const CALIBRATION_DIR_NAME = "pi-tps-calibration";

export interface CalibrationEntry {
	ratio: number;
	samples: number;
	/** Wall-clock milliseconds of the last update. */
	updatedAt: number;
}

/** One request's reported output tokens and the raw estimate for the same tokens. */
export interface CalibrationSample {
	reported: number;
	estimated: number;
}

interface CalibrationFile {
	version: 1;
	models: Record<string, CalibrationEntry>;
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

export function clampRatio(ratio: number): number {
	return Math.min(CALIBRATION_MAX_RATIO, Math.max(CALIBRATION_MIN_RATIO, ratio));
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
export function nextEntry(
	previous: CalibrationEntry | undefined,
	sample: CalibrationSample,
	now: number,
): CalibrationEntry {
	const observed = clampRatio(sample.reported / sample.estimated);
	if (!previous) return { ratio: observed, samples: 1, updatedAt: now };
	const ratio = clampRatio(previous.ratio + CALIBRATION_ALPHA * (observed - previous.ratio));
	return { ratio, samples: previous.samples + 1, updatedAt: now };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): CalibrationEntry | undefined {
	if (!isRecord(value)) return undefined;
	const { ratio, samples, updatedAt } = value;
	if (typeof ratio !== "number" || !Number.isFinite(ratio)) return undefined;
	if (typeof samples !== "number" || !Number.isInteger(samples) || samples < 1) return undefined;
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
	return { ratio: clampRatio(ratio), samples, updatedAt };
}

const UNSUPPORTED_FORMAT = "unsupported format, expected { version: 1, models: {...} }";

/**
 * Parses one calibration version. `usable` is false when the content cannot be used at all; individual invalid
 * entries are skipped with a warning.
 */
export function parseCalibration(text: string): {
	models: Map<string, CalibrationEntry>;
	usable: boolean;
	warning?: string;
} {
	const models = new Map<string, CalibrationEntry>();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return { models, usable: false, warning: `invalid JSON (${errorMessage(error)})` };
	}
	if (!isRecord(json)) return { models, usable: false, warning: UNSUPPORTED_FORMAT };
	const { version, models: entries } = json;
	if (version !== 1 || !isRecord(entries)) return { models, usable: false, warning: UNSUPPORTED_FORMAT };
	let skipped = 0;
	for (const [key, value] of Object.entries(entries)) {
		const entry = parseEntry(value);
		if (entry) models.set(key, entry);
		else skipped++;
	}
	if (skipped > 0) {
		return { models, usable: true, warning: `skipped ${skipped} invalid entr${skipped === 1 ? "y" : "ies"}` };
	}
	return { models, usable: true };
}

const VERSION_NAME = /^(\d{10})\.json$/;
/** Versions kept after a publish, so a reader that listed the directory a moment ago still finds its file. */
const KEPT_VERSIONS = 3;
/** Publish attempts per flush; each lost race means another session published in between. */
const PUBLISH_ATTEMPTS = 5;

function versionName(version: number): string {
	return `${String(version).padStart(10, "0")}.json`;
}

interface PendingSample {
	key: string;
	sample: CalibrationSample;
	at: number;
}

interface Snapshot {
	/** Highest version number present, also when its file is unusable, so the next publish goes past it. */
	version: number;
	models: Map<string, CalibrationEntry>;
	warning?: string;
}

function replay(base: ReadonlyMap<string, CalibrationEntry>, samples: readonly PendingSample[]) {
	const models = new Map(base);
	for (const { key, sample, at } of samples) models.set(key, nextEntry(models.get(key), sample, at));
	return models;
}

/**
 * Calibration ratios per `<provider>/<model>`, shared by every Pi session through numbered versions in one
 * directory. An update publishes the next version, derived from the newest one, with an exclusive and atomic file
 * creation; a session that loses the race re-reads and tries again, so no session overwrites or reverts another's
 * samples, and no lock is needed. Samples that could not be published yet stay queued as samples and are applied on
 * top of the newest version, both for this session's ratios and for the next publish.
 *
 * Methods return warning texts instead of reporting them so the caller can use the context of its event.
 */
export class CalibrationStore {
	private published = new Map<string, CalibrationEntry>();
	private pending: PendingSample[] = [];
	private models = new Map<string, CalibrationEntry>();
	private writeWarned = false;

	constructor(
		private readonly dir: string,
		private readonly files: FileLayer,
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

	ratio(key: string): number | undefined {
		return this.models.get(key)?.ratio;
	}

	entry(key: string): CalibrationEntry | undefined {
		return this.models.get(key);
	}

	/** Applies one sample and publishes it. Returns a warning the first time writing fails. */
	update(key: string, sample: CalibrationSample, now: number): string | undefined {
		if (!isCalibratable(sample)) return undefined;
		this.pending.push({ key, sample, at: now });
		this.models = replay(this.published, this.pending);
		return this.flush();
	}

	/** Publishes the queued samples on top of the newest version; called after each update and at shutdown. */
	flush(): string | undefined {
		for (let attempt = 0; attempt < PUBLISH_ATTEMPTS && this.pending.length > 0; attempt++) {
			let snapshot: Snapshot;
			try {
				snapshot = this.readNewest();
			} catch (error) {
				return this.writeFailure(error);
			}
			const next = replay(snapshot.models, this.pending);
			this.published = snapshot.models;
			this.models = next;
			const file: CalibrationFile = { version: 1, models: Object.fromEntries(next) };
			const version = snapshot.version + 1;
			try {
				if (!this.files.publish(this.path(version), `${JSON.stringify(file, null, "\t")}\n`)) continue;
			} catch (error) {
				return this.writeFailure(error);
			}
			this.published = next;
			this.pending = [];
			try {
				this.prune(version);
			} catch (error) {
				return this.writeFailure(error);
			}
		}
		return undefined;
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

	/** The newest usable version; unusable newer files are reported and skipped. */
	private readNewest(): Snapshot {
		const versions = this.versions();
		const highest = versions[0] ?? 0;
		let warning: string | undefined;
		for (const version of versions) {
			const text = this.files.read(this.path(version));
			// Pruned by another session between listing and reading; an older version follows.
			if (text === undefined) continue;
			const parsed = parseCalibration(text);
			if (parsed.warning !== undefined) warning ??= `${this.path(version)}: ${parsed.warning}`;
			if (!parsed.usable) continue;
			return warning === undefined
				? { version: highest, models: parsed.models }
				: { version: highest, models: parsed.models, warning };
		}
		return warning === undefined
			? { version: highest, models: new Map() }
			: { version: highest, models: new Map(), warning };
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
