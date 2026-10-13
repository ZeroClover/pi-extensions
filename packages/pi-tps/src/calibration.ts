import {
	CALIBRATION_ALPHA,
	CALIBRATION_MAX_RATIO,
	CALIBRATION_MIN_ESTIMATE,
	CALIBRATION_MIN_RATIO,
} from "./constants.ts";
import { errorMessage, type FileLayer } from "./files.ts";

export const CALIBRATION_FILE_NAME = "pi-tps-calibration.json";

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

/** Parses the calibration file. Unusable content yields an empty store and a warning. */
export function parseCalibration(text: string): { models: Map<string, CalibrationEntry>; warning?: string } {
	const models = new Map<string, CalibrationEntry>();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return { models, warning: `invalid JSON (${errorMessage(error)})` };
	}
	if (!isRecord(json)) return { models, warning: UNSUPPORTED_FORMAT };
	const { version, models: entries } = json;
	if (version !== 1 || !isRecord(entries)) return { models, warning: UNSUPPORTED_FORMAT };
	let skipped = 0;
	for (const [key, value] of Object.entries(entries)) {
		const entry = parseEntry(value);
		if (entry) models.set(key, entry);
		else skipped++;
	}
	if (skipped > 0) return { models, warning: `skipped ${skipped} invalid entr${skipped === 1 ? "y" : "ies"}` };
	return { models };
}

/**
 * Calibration ratios per `<provider>/<model>`, persisted in one JSON file. Methods return warning texts instead
 * of reporting them so the caller can use the context of the event it is handling.
 */
export class CalibrationStore {
	private models = new Map<string, CalibrationEntry>();
	/** Keys updated in memory but not yet written; they win over the disk copy until a write succeeds. */
	private readonly unsaved = new Set<string>();
	private writeWarned = false;

	constructor(
		private readonly path: string,
		private readonly files: FileLayer,
	) {}

	/** Replaces the in-memory ratios with the file content. A missing file is an empty store. */
	load(): string | undefined {
		this.models = new Map();
		let text: string | undefined;
		try {
			text = this.files.read(this.path);
		} catch (error) {
			return `pi-tps: cannot read ${this.path}: ${errorMessage(error)}; calibration starts empty`;
		}
		if (text === undefined) return undefined;
		const parsed = parseCalibration(text);
		this.models = parsed.models;
		return parsed.warning === undefined ? undefined : `pi-tps: ${this.path}: ${parsed.warning}`;
	}

	/** The file's entries, or undefined when it is missing or unusable (already reported by {@link load}). */
	private readQuietly(): Map<string, CalibrationEntry> | undefined {
		try {
			const text = this.files.read(this.path);
			if (text === undefined) return undefined;
			const parsed = parseCalibration(text);
			return parsed.warning === undefined ? parsed.models : undefined;
		} catch {
			return undefined;
		}
	}

	ratio(key: string): number | undefined {
		return this.models.get(key)?.ratio;
	}

	entry(key: string): CalibrationEntry | undefined {
		return this.models.get(key);
	}

	/**
	 * Applies one sample and writes the file inside a cross-process lock: the file is re-read and merged first, so
	 * concurrent sessions neither lose updates nor build on stale ratios. Returns a warning the first time writing
	 * fails; the in-memory ratios then stay authoritative for the session.
	 */
	update(key: string, sample: CalibrationSample, now: number): string | undefined {
		if (!isCalibratable(sample)) return undefined;
		let release: (() => void) | undefined;
		try {
			release = this.files.lock(this.path);
		} catch (error) {
			this.applyInMemory(key, sample, now);
			return this.writeFailure(error);
		}
		if (!release) {
			// Another session holds the file; keep the sample and write it with the next update.
			this.applyInMemory(key, sample, now);
			return undefined;
		}
		try {
			const onDisk = this.readQuietly();
			if (onDisk) {
				for (const [diskKey, entry] of onDisk) if (!this.unsaved.has(diskKey)) this.models.set(diskKey, entry);
			}
			this.applyInMemory(key, sample, now);
			const file: CalibrationFile = { version: 1, models: Object.fromEntries(this.models) };
			try {
				this.files.write(this.path, `${JSON.stringify(file, null, "\t")}\n`);
			} catch (error) {
				return this.writeFailure(error);
			}
			this.unsaved.clear();
			return undefined;
		} finally {
			release();
		}
	}

	private applyInMemory(key: string, sample: CalibrationSample, now: number): void {
		this.models.set(key, nextEntry(this.models.get(key), sample, now));
		this.unsaved.add(key);
	}

	private writeFailure(error: unknown): string | undefined {
		if (this.writeWarned) return undefined;
		this.writeWarned = true;
		return `pi-tps: cannot write ${this.path}: ${errorMessage(error)}; calibration is kept for this session only`;
	}
}
