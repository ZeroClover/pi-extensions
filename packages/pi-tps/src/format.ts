import type { LabelStyle } from "./config.ts";
import type { LiveSnapshot, RunSummary, SessionSummary, StatusSnapshot, WorkingSnapshot } from "./telemetry.ts";

/** One printed field. A segment with `tps` is coloured by the thresholds, every other one by the base colour. */
export interface Segment {
	text: string;
	tps?: number;
}

/** A readout line: an optional spinner frame, followed by the fields. */
export interface Line {
	indicator?: string;
	segments: Segment[];
}

/** Separator between fields: ` · ` reads well between words, a space suffices between symbols. */
export const FIELD_SEPARATOR: Record<LabelStyle, string> = { text: " · ", symbols: " " };

const UNKNOWN = "—";
/** Marks a figure that relies on an uncalibrated or substituted estimate. */
const ESTIMATED = "~";

/** A field in both vocabularies; an absent form omits the field in that style. */
interface Field {
	text?: string;
	symbol?: string;
	tps?: number;
}

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

function rate(value: number, estimated: boolean): Field {
	const marker = estimated ? ESTIMATED : "";
	const figure = `${marker}${formatTps(value)}`;
	return { text: `TPS ${figure} tok/s`, symbol: `»${figure}/s`, tps: value };
}

const UNKNOWN_RATE: Field = { text: `TPS ${UNKNOWN}`, symbol: `»${UNKNOWN}` };

function burst(value: number): Field {
	return { text: `burst ${formatTps(value)} tok/s`, symbol: `↯${formatTps(value)}/s` };
}

function ttft(ms: number | undefined): Field {
	const figure = ms === undefined ? UNKNOWN : formatDuration(ms);
	return { text: `TTFT ${figure}`, symbol: `⇥${figure}` };
}

function elapsed(ms: number): Field {
	return { text: formatDuration(ms), symbol: formatDuration(ms) };
}

/** Input tokens with cache reads and writes folded in, and the share read from the cache. */
function input(tokens: number, cacheRead: number, cacheWrite: number): Field | undefined {
	const total = tokens + cacheRead + cacheWrite;
	if (total <= 0) return undefined;
	const figure = formatTokens(total);
	if (cacheRead <= 0) return { text: `in ${figure}`, symbol: `↑${figure}` };
	const share = `${Math.round((cacheRead / total) * 100)}%`;
	return { text: `in ${figure} (cache ${share})`, symbol: `↑${figure} ↻${share}` };
}

function output(tokens: number): Field {
	return { text: `out ${formatTokens(tokens)}`, symbol: `↓${formatTokens(tokens)}` };
}

function thinking(tokens: number, ms: number | undefined): Field {
	// Below 50 ms the duration would print as 0.0s and say nothing.
	const duration = ms !== undefined && ms >= 50 ? ` ${formatDuration(ms)}` : "";
	return { text: `think ${formatTokens(tokens)}${duration}`, symbol: `✻${formatTokens(tokens)}${duration}` };
}

function stall(ms: number, count: number): Field {
	const figure = `${formatDuration(ms)}×${count}`;
	return { text: `stall ${figure}`, symbol: `‖${figure}` };
}

function count(label: string, value: number): Field {
	return { text: `${label} ${value}`, symbol: `×${value}` };
}

function cost(usd: number): Field {
	return { text: formatCost(usd), symbol: formatCost(usd) };
}

function live(snapshot: LiveSnapshot): Field[] {
	const fields: Field[] = [];
	if (snapshot.phase === "waiting") {
		fields.push(ttft(snapshot.elapsedMs));
	} else {
		fields.push(snapshot.liveTps === undefined ? UNKNOWN_RATE : rate(snapshot.liveTps, !snapshot.calibrated));
		fields.push(ttft(snapshot.ttftMs), output(snapshot.outputTokens));
		if (snapshot.thinkingTokens !== undefined) fields.push(thinking(snapshot.thinkingTokens, snapshot.thinkingMs));
	}
	if (snapshot.request > 1) fields.push(count("req", snapshot.request));
	return fields;
}

function working(snapshot: WorkingSnapshot): Field[] {
	return [
		{ text: `run ${formatDuration(snapshot.elapsedMs)}`, symbol: formatDuration(snapshot.elapsedMs) },
		count("req", snapshot.requests),
		output(snapshot.outputTokens),
	];
}

function summaryRate(summary: RunSummary | SessionSummary): Field {
	if (summary.tps !== undefined) return rate(summary.tps, summary.estimated);
	if (summary.burstTps !== undefined) return burst(summary.burstTps);
	return UNKNOWN_RATE;
}

function run(summary: RunSummary): Field[] {
	const fields: Field[] = [
		summary.aborted ? { text: "aborted", symbol: "✗" } : { symbol: "✓" },
		summaryRate(summary),
		ttft(summary.ttftMs),
		elapsed(summary.elapsedMs),
	];
	const inputField = input(summary.inputTokens, summary.cacheReadTokens, summary.cacheWriteTokens);
	if (inputField) fields.push(inputField);
	fields.push(output(summary.visibleOutputTokens));
	if (summary.thinkingTokens > 0) fields.push(thinking(summary.thinkingTokens, summary.thinkingMs));
	if (summary.stallMs > 0) fields.push(stall(summary.stallMs, summary.stallCount));
	fields.push(count("req", summary.requests));
	if (summary.cost !== undefined) fields.push(cost(summary.cost));
	return fields;
}

const SESSION_MARKER: Field = { text: "session", symbol: "Σ" };

function session(summary: SessionSummary): Field[] {
	const fields: Field[] = [SESSION_MARKER, summaryRate(summary), ttft(summary.ttftMs)];
	const inputField = input(summary.inputTokens, summary.cacheReadTokens, summary.cacheWriteTokens);
	if (inputField) fields.push(inputField);
	fields.push(output(summary.visibleOutputTokens), count("runs", summary.runs));
	if (summary.cost !== undefined) fields.push(cost(summary.cost));
	return fields;
}

function fieldsOf(snapshot: StatusSnapshot): Field[] {
	switch (snapshot.phase) {
		case "waiting":
		case "streaming":
			return live(snapshot);
		case "working":
			return working(snapshot);
		case "run":
			return run(snapshot.run);
		case "session":
			return session(snapshot.session);
		case "empty":
			return [snapshot.mode === "session" ? SESSION_MARKER : { symbol: "·" }, UNKNOWN_RATE, ttft(undefined)];
	}
}

/**
 * Lays out the readout for a snapshot in one label style, most important fields first so that footer truncation
 * drops the tail. `indicator` is the spinner frame shown while a run is active.
 */
export function formatSnapshot(snapshot: StatusSnapshot, style: LabelStyle, indicator: string): Line {
	const segments: Segment[] = [];
	for (const field of fieldsOf(snapshot)) {
		const text = style === "text" ? field.text : field.symbol;
		if (text === undefined) continue;
		segments.push(field.tps === undefined ? { text } : { text, tps: field.tps });
	}
	const active = snapshot.phase === "waiting" || snapshot.phase === "streaming" || snapshot.phase === "working";
	return active ? { indicator, segments } : { segments };
}

export function plainText(line: Line, style: LabelStyle): string {
	const fields = line.segments.map((segment) => segment.text).join(FIELD_SEPARATOR[style]);
	return line.indicator === undefined ? fields : `${line.indicator} ${fields}`;
}
