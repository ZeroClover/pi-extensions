import type { LiveSnapshot, SessionAggregate, StatusSnapshot, TelemetryRecord } from "./telemetry.ts";

/** Single-cell glyphs of the readout; the README legend documents each one. */
export const GLYPH = {
	settled: "✓",
	aborted: "✗",
	session: "Σ",
	empty: "·",
	ttft: "τ",
	rate: "Δ",
	burst: "↯",
	uncalibrated: "~",
	input: "↑",
	output: "↓",
	cache: "↻",
	thinking: "∴",
	count: "×",
	placeholder: "–",
} as const;

/** One field of the readout. A segment with `tps` is coloured by the thresholds, every other one by the base colour. */
export interface Segment {
	text: string;
	tps?: number;
}

export function formatTps(value: number): string {
	return value.toFixed(1);
}

export function formatTokens(count: number): string {
	const rounded = Math.round(count);
	if (rounded < 1000) return String(rounded);
	if (rounded < 999_950) return `${(rounded / 1000).toFixed(1)}k`;
	return `${(rounded / 1_000_000).toFixed(1)}M`;
}

/** Seconds with one decimal, used for TTFT. */
export function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Elapsed times: seconds with one decimal below a minute, then minutes and seconds, then hours and minutes. */
export function formatDuration(ms: number): string {
	if (ms < 59_950) return formatSeconds(ms);
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 3600) {
		return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

export function formatCost(usd: number): string {
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	if (usd >= 0.01) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(4)}`;
}

const PLACEHOLDER_TPS: Segment = { text: `${GLYPH.rate}${GLYPH.placeholder}` };

function ttft(ms: number | undefined): Segment {
	return { text: `${GLYPH.ttft}${ms === undefined ? GLYPH.placeholder : formatSeconds(ms)}` };
}

function rate(value: number, marker = ""): Segment {
	return { text: `${GLYPH.rate}${formatTps(value)}${marker}`, tps: value };
}

/** Input tokens with cache reads and writes folded in, marked when part of it came from or went to the cache. */
function input(tokens: number, cacheRead: number, cacheWrite: number): Segment {
	const cached = cacheRead + cacheWrite > 0 ? GLYPH.cache : "";
	return { text: `${GLYPH.input}${formatTokens(tokens + cacheRead + cacheWrite)}${cached}` };
}

function output(tokens: number, marker = ""): Segment {
	return { text: `${GLYPH.output}${formatTokens(tokens)}${marker}` };
}

function live(snapshot: LiveSnapshot, indicator: string): Segment[] {
	if (snapshot.phase === "waiting") return [{ text: indicator }, ttft(snapshot.elapsedMs), PLACEHOLDER_TPS];
	const marker = snapshot.calibrated ? "" : GLYPH.uncalibrated;
	const segments: Segment[] = [
		{ text: indicator },
		ttft(snapshot.ttftMs),
		snapshot.liveTps === undefined ? PLACEHOLDER_TPS : rate(snapshot.liveTps, marker),
		output(snapshot.outputTokens, marker),
	];
	if (snapshot.thinkingTokens !== undefined) {
		segments.push({
			text: `${GLYPH.thinking}${GLYPH.output}${formatTokens(snapshot.thinkingTokens)}${marker}`,
		});
		if (snapshot.thinkingMs !== undefined) segments.push({ text: formatDuration(snapshot.thinkingMs) });
	}
	return segments;
}

function thinking(record: TelemetryRecord): Segment[] {
	const duration = record.thinkingMs === undefined ? [] : [{ text: formatDuration(record.thinkingMs) }];
	if (record.thinkingTps !== undefined) {
		return [{ text: `${GLYPH.thinking}${GLYPH.rate}${formatTps(record.thinkingTps)}` }, ...duration];
	}
	if (record.thinkingTokens !== undefined) {
		return [{ text: `${GLYPH.thinking}${GLYPH.output}${formatTokens(record.thinkingTokens)}` }, ...duration];
	}
	return [];
}

function settledRate(record: TelemetryRecord, fallbackTps: number | undefined): Segment {
	if (record.burst && record.throughputTps !== undefined) {
		return { text: `${GLYPH.burst}${formatTps(record.throughputTps)}` };
	}
	if (record.outputTps !== undefined) return rate(record.outputTps, record.estimated ? GLYPH.uncalibrated : "");
	if (fallbackTps !== undefined) return rate(fallbackTps);
	return PLACEHOLDER_TPS;
}

function last(record: TelemetryRecord, fallbackTps: number | undefined): Segment[] {
	const segments: Segment[] = [
		{ text: record.outcome === "aborted" ? GLYPH.aborted : GLYPH.settled },
		ttft(record.ttftMs),
		settledRate(record, fallbackTps),
		input(record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens),
		output(record.outputTokens),
		{ text: formatDuration(record.elapsedMs) },
	];
	if (record.cost !== undefined) segments.push({ text: formatCost(record.cost) });
	return [...segments, ...thinking(record)];
}

function session(aggregate: SessionAggregate): Segment[] {
	const segments: Segment[] = [
		{ text: GLYPH.session },
		ttft(aggregate.meanTtftMs),
		aggregate.meanOutputTps === undefined ? PLACEHOLDER_TPS : rate(aggregate.meanOutputTps),
		input(aggregate.inputTokens, aggregate.cacheReadTokens, aggregate.cacheWriteTokens),
		output(aggregate.outputTokens),
	];
	if (aggregate.cost !== undefined) segments.push({ text: formatCost(aggregate.cost) });
	if (aggregate.meanThinkingTps !== undefined) {
		segments.push({ text: `${GLYPH.thinking}${GLYPH.rate}${formatTps(aggregate.meanThinkingTps)}` });
	}
	segments.push({ text: `${GLYPH.count}${aggregate.count}` });
	return segments;
}

/**
 * Lays out the readout fields for a snapshot, most important first so that footer truncation drops the tail.
 * `indicator` is the current spinner frame, used while a request is in flight.
 */
export function formatSnapshot(snapshot: StatusSnapshot, indicator: string): Segment[] {
	switch (snapshot.phase) {
		case "waiting":
		case "streaming":
			return live(snapshot, indicator);
		case "last":
			return last(snapshot.record, snapshot.fallbackTps);
		case "session":
			return session(snapshot.aggregate);
		case "empty":
			return [{ text: snapshot.mode === "session" ? GLYPH.session : GLYPH.empty }, ttft(undefined), PLACEHOLDER_TPS];
	}
}

export function plainText(segments: readonly Segment[]): string {
	return segments.map((segment) => segment.text).join(" ");
}
