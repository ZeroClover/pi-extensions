import { type ColorSpec, DEFAULT_SEPARATOR, type MetricConfig, type MetricSettings, selectColor } from "./config.ts";
import type {
	Averages,
	IdleSnapshot,
	LiveSnapshot,
	SessionTotals,
	StatusSnapshot,
	WorkingSnapshot,
} from "./telemetry.ts";

/**
 * How a segment is coloured: the base, burst or theme outcome colour, or a colour a threshold list resolved. The
 * separator between fields has its own colour, applied by the renderer.
 */
export type Role = "base" | "burst" | "success" | "error" | { color: ColorSpec };

export interface Segment {
	text: string;
	role: Role;
}

/** The segments of one field, printed without anything between them. */
export type Field = Segment[];

/** A readout line: an optional marker (spinner frame or outcome), then the fields. */
export interface Line {
	marker?: Segment;
	fields: Field[];
}

const UNKNOWN = "-";
/** `x` with a combining macron, the sign of a mean. pi-tui counts it as one column. */
export const MEAN = "x̄";
const BURST = "↯";

export function formatTps(value: number): string {
	return value.toFixed(1);
}

const TOKEN_UNITS: [string, number][] = [
	["K", 1e3],
	["M", 1e6],
	["B", 1e9],
];

/** Integers below 1000, then K, M or B with one decimal, dropping a trailing `.0`. */
export function formatTokens(count: number): string {
	const rounded = Math.round(count);
	if (rounded < 1000) return String(rounded);
	for (let i = 0; i < TOKEN_UNITS.length; i++) {
		const [suffix, size] = TOKEN_UNITS[i] ?? ["", 1];
		const value = (rounded / size).toFixed(1);
		if (Number(value) < 1000 || i === TOKEN_UNITS.length - 1) {
			return `${value.endsWith(".0") ? value.slice(0, -2) : value}${suffix}`;
		}
	}
	return String(rounded);
}

const DURATION_UNITS: [string, number][] = [
	["d", 86_400],
	["h", 3600],
	["m", 60],
	["s", 1],
];

/** One decimal below a minute, then the two largest units without decimals (`1m 30s`, `2h 15m`). */
export function formatDuration(ms: number): string {
	if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	for (let i = 0; i < DURATION_UNITS.length - 1; i++) {
		const [label, size] = DURATION_UNITS[i] ?? ["s", 1];
		if (total < size) continue;
		const [nextLabel, nextSize] = DURATION_UNITS[i + 1] ?? ["s", 1];
		return `${Math.floor(total / size)}${label} ${Math.floor((total % size) / nextSize)}${nextLabel}`;
	}
	return `${total}s`;
}

export function formatCost(usd: number): string {
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	if (usd >= 0.01) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(4)}`;
}

/**
 * Colour of a live figure: in relative mode with a percentage, through the relative list; otherwise through the
 * absolute list. Undefined (the base colour) below the lowest threshold.
 */
function metricColor(settings: MetricSettings, percent: number | undefined, absolute: number): Role {
	const color =
		settings.mode === "relative" && percent !== undefined
			? selectColor(settings.relative, percent)
			: selectColor(settings.absolute, absolute);
	return color ? { color } : "base";
}

/** Live TPS as a percentage of the model's TPS average; a burst average is no reference for a streamed rate. */
export function tpsColor(settings: MetricSettings, liveTps: number, average: Averages): Role {
	const percent = average.tps === undefined ? undefined : (liveTps / average.tps) * 100;
	return metricColor(settings, percent, liveTps);
}

/** TTFT as the average over the live value, so faster than usual reads high; a live 0 is the highest band. */
export function ttftColor(settings: MetricSettings, liveMs: number, average: Averages): Role {
	let percent: number | undefined;
	if (average.ttftMs !== undefined) percent = liveMs > 0 ? (average.ttftMs / liveMs) * 100 : Number.POSITIVE_INFINITY;
	return metricColor(settings, percent, liveMs / 1000);
}

const base = (text: string): Segment => ({ text, role: "base" });

/** An average TPS: the streamed rate, else a burst throughput with `↯`. Undefined without either. */
function averageTps(average: Averages): Segment[] | undefined {
	if (average.tps !== undefined) return [base(`${MEAN}${formatTps(average.tps)}`)];
	if (average.burstTps !== undefined) {
		return [base(MEAN), { text: BURST, role: "burst" }, base(formatTps(average.burstTps))];
	}
	return undefined;
}

/** `48.6 (x̄52.3) TPS`: the live number and the label share the live colour, the average uses the base colour. */
function liveTpsField(snapshot: LiveSnapshot, settings: MetricSettings): Field {
	const { liveTps, average } = snapshot;
	const role = liveTps === undefined ? "base" : tpsColor(settings, liveTps, average);
	const field: Field = [{ text: liveTps === undefined ? UNKNOWN : formatTps(liveTps), role }];
	const reference = averageTps(average);
	if (reference) field.push(base(" ("), ...reference, base(")"));
	field.push({ text: " TPS", role });
	return field;
}

/** `TTFT 1.2s (x̄1.1s)`: the label and the live time share the live colour. */
function liveTtftField(snapshot: LiveSnapshot, settings: MetricSettings): Field {
	const { average } = snapshot;
	// The wait counts up until the first content; in the waiting phase that is the elapsed time.
	const ms = snapshot.ttftMs ?? snapshot.elapsedMs;
	// A hidden thinking phase folds thinking time into the wait, so its colour would judge thinking as latency.
	const role =
		snapshot.ttftMs === undefined && snapshot.thinking === "hidden" ? "base" : ttftColor(settings, ms, average);
	const field: Field = [{ text: `TTFT ${formatDuration(ms)}`, role }];
	if (average.ttftMs !== undefined) field.push(base(` (${MEAN}${formatDuration(average.ttftMs)})`));
	return field;
}

/** `x̄52.3 TPS` and `TTFT x̄1.1s`, or `-` for a metric without an average. */
function averageFields(average: Averages): Field[] {
	const tps = averageTps(average) ?? [base(UNKNOWN)];
	const ttft = average.ttftMs === undefined ? UNKNOWN : `${MEAN}${formatDuration(average.ttftMs)}`;
	return [[...tps, base(" TPS")], [base(`TTFT ${ttft}`)]];
}

const plain = (text: string): Field => [base(text)];

/** Thinking count and time; without a count (hidden thinking) the time alone. */
function thinkingField(tokens: number | undefined, ms: number | undefined): Field {
	const duration = formatDuration(ms ?? 0);
	if (tokens === undefined) return plain(`⠿${duration}`);
	// Below 50 ms the duration would print as 0.0s and say nothing.
	const suffix = ms !== undefined && ms >= 50 ? ` ${duration}` : "";
	return plain(`⠿${formatTokens(tokens)}${suffix}`);
}

function requestsField(count: number): Field {
	return plain(`${count}➤`);
}

function live(snapshot: LiveSnapshot, metrics: MetricConfig): Field[] {
	const fields = [liveTpsField(snapshot, metrics.tps), liveTtftField(snapshot, metrics.ttft)];
	// Live token counts are estimates; before any content arrived (a hidden thinking phase) there is none to show.
	if (snapshot.ttftMs !== undefined) fields.push(plain(`↓${formatTokens(snapshot.outputTokens)}`));
	if (snapshot.thinking !== "none") fields.push(thinkingField(snapshot.thinkingTokens, snapshot.thinkingMs));
	if (snapshot.request > 1) fields.push(requestsField(snapshot.request));
	return fields;
}

function working(snapshot: WorkingSnapshot): Field[] {
	return [
		...averageFields(snapshot.average),
		plain(`run ${formatDuration(snapshot.elapsedMs)}`),
		requestsField(snapshot.requests),
		plain(`↓${formatTokens(snapshot.outputTokens)}`),
	];
}

/** Input tokens with cache reads and writes folded in, and the share read from the cache. */
function inputField(totals: SessionTotals): Field | undefined {
	const total = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
	if (total <= 0) return undefined;
	const share = totals.cacheReadTokens > 0 ? ` ◎${Math.round((totals.cacheReadTokens / total) * 100)}%` : "";
	return plain(`↑${formatTokens(total)}${share}`);
}

function sessionFields(totals: SessionTotals): Field[] {
	const fields: Field[] = [
		plain(`${totals.runs} ${totals.runs === 1 ? "run" : "runs"} in ${formatDuration(totals.elapsedMs)}`),
		requestsField(totals.requests),
	];
	const input = inputField(totals);
	if (input) fields.push(input);
	fields.push(plain(`↓${formatTokens(totals.visibleOutputTokens)}`));
	if (totals.thinkingTokens > 0) fields.push(plain(`⠿${formatTokens(totals.thinkingTokens)}`));
	if (totals.cost !== undefined) fields.push(plain(formatCost(totals.cost)));
	return fields;
}

function idle(snapshot: IdleSnapshot): Line {
	const { session } = snapshot;
	if (!session) return { fields: averageFields({}) };
	const marker: Segment = session.lastAborted ? { text: "✗", role: "error" } : { text: "✓", role: "success" };
	return { marker, fields: [...averageFields(snapshot.average), ...sessionFields(session)] };
}

/**
 * Lays out the readout for a snapshot, most important fields first so that footer truncation drops the tail.
 * `indicator` is the spinner frame shown while a run is active; `metrics` colour the live TPS and TTFT.
 */
export function formatSnapshot(snapshot: StatusSnapshot, indicator: string, metrics: MetricConfig): Line {
	switch (snapshot.phase) {
		case "waiting":
		case "streaming":
			return { marker: base(indicator), fields: live(snapshot, metrics) };
		case "working":
			return { marker: base(indicator), fields: working(snapshot) };
		case "idle":
			return idle(snapshot);
	}
}

/** The line as plain text, fields joined with `separator`. */
export function plainText(line: Line, separator = DEFAULT_SEPARATOR): string {
	const fields = line.fields.map((field) => field.map((segment) => segment.text).join("")).join(separator);
	return line.marker === undefined ? fields : `${line.marker.text} ${fields}`;
}
