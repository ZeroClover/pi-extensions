import { calibrationKey } from "./calibration.ts";
import { AVERAGE_ALPHA, AVERAGE_CLAMP_FACTOR, AVERAGE_WARMUP_SAMPLES } from "./constants.ts";
import type { Averages, ModelRef, RequestRecord } from "./telemetry.ts";

/** One smoothed value and the number of samples folded into it. */
export interface Smoothed {
	value: number;
	samples: number;
}

/**
 * Folds a sample into an average: the plain mean of the first ten samples, then an exponential moving average with
 * weight 0.1 whose samples are first clamped to between a third of and three times the current average.
 */
export function smooth(current: Smoothed | undefined, sample: number): Smoothed {
	if (!current) return { value: sample, samples: 1 };
	const { value, samples } = current;
	if (samples < AVERAGE_WARMUP_SAMPLES) {
		return { value: (value * samples + sample) / (samples + 1), samples: samples + 1 };
	}
	const clamped = Math.min(value * AVERAGE_CLAMP_FACTOR, Math.max(value / AVERAGE_CLAMP_FACTOR, sample));
	return { value: value + AVERAGE_ALPHA * (clamped - value), samples: samples + 1 };
}

type Metric = keyof Averages;

/** The samples a request contributes: only settled requests, and only positive figures. */
function samplesOf(record: RequestRecord): [Metric, number][] {
	if (record.outcome !== "settled") return [];
	const samples: [Metric, number][] = [];
	// An average of 0 would clamp every later sample to 0 and leave the relative percentage undefined.
	const add = (metric: Metric, value: number | undefined): void => {
		if (value !== undefined && value > 0) samples.push([metric, value]);
	};
	if (record.burst) add("burstTps", record.throughputTps);
	else add("tps", record.tps);
	add("ttftMs", record.ttftMs);
	return samples;
}

/** The model a request was sent under: the selected model when it is recorded, else the serving model. */
function sentUnder(record: RequestRecord): ModelRef {
	return record.requested ?? { provider: record.provider, model: record.model };
}

/**
 * Per-model averages over the request records of the branch, replayed in order, and the last record, which decides
 * the current model.
 */
export class ModelAverages {
	private models = new Map<string, Partial<Record<Metric, Smoothed>>>();
	private last: RequestRecord | undefined;

	/** Replaces every average with a replay of the records, oldest first. */
	rebuild(records: Iterable<RequestRecord>): void {
		this.models = new Map();
		this.last = undefined;
		for (const record of records) this.fold(record);
	}

	/** Adds one recorded request, aborted ones included: they contribute no sample but are the last record. */
	fold(record: RequestRecord): void {
		this.last = record;
		const key = calibrationKey(record.provider, record.model);
		for (const [metric, sample] of samplesOf(record)) {
			const entry = this.models.get(key) ?? {};
			entry[metric] = smooth(entry[metric], sample);
			this.models.set(key, entry);
		}
	}

	of(provider: string, model: string): Averages {
		const entry = this.models.get(calibrationKey(provider, model));
		const averages: Averages = {};
		if (!entry) return averages;
		for (const metric of ["tps", "burstTps", "ttftMs"] as const) {
			const smoothed = entry[metric];
			if (smoothed) averages[metric] = smoothed.value;
		}
		return averages;
	}

	/**
	 * The model whose averages the idle and working readouts show: the model that served the last request when that
	 * request was sent under the selected model (a virtual model has no records of its own), else the selected model.
	 */
	current(selected: ModelRef | undefined): ModelRef | undefined {
		const last = this.last;
		if (!last) return selected;
		const under = sentUnder(last);
		if (selected && calibrationKey(under.provider, under.model) !== calibrationKey(selected.provider, selected.model)) {
			return selected;
		}
		return { provider: last.provider, model: last.model };
	}
}
