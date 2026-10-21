import { expect } from "vitest";
import type { Pi } from "../../../tools/e2e/src/index.ts";
import type { IdleSnapshot, LiveSnapshot, RequestRecord, RunRecord, StatusSnapshot } from "../src/telemetry.ts";

/** pi-tps's documented event-bus channels and session entry type (README, "Telemetry"). */
export const STATUS = "pi-tps:status";
export const TELEMETRY = "pi-tps:telemetry";
export const RUN = "pi-tps:run";
export const REQUEST = "pi-tps:request";
export const ENTRY_TYPE = "pi-tps";

function isRequestRecord(value: unknown): value is RequestRecord {
	return typeof value === "object" && value !== null && "outcome" in value && typeof value.outcome === "string";
}

function isRunRecord(value: unknown): value is RunRecord {
	return typeof value === "object" && value !== null && "requests" in value && Array.isArray(value.requests);
}

function isSnapshot(value: unknown): value is StatusSnapshot {
	return typeof value === "object" && value !== null && "phase" in value && typeof value.phase === "string";
}

/** Request records broadcast on `pi-tps:telemetry`. */
export function requestRecords(pi: Pi): RequestRecord[] {
	return pi.events.collect(TELEMETRY).filter(isRequestRecord);
}

/** Run records broadcast on `pi-tps:run`. */
export function runRecords(pi: Pi): RunRecord[] {
	return pi.events.collect(RUN).filter(isRunRecord);
}

/** Snapshots broadcast on `pi-tps:status`, in order. */
export function snapshots(pi: Pi): StatusSnapshot[] {
	return pi.events.collect(STATUS).filter(isSnapshot);
}

/** Snapshots of a request in flight after its first token arrived. */
export function streaming(pi: Pi): LiveSnapshot[] {
	return snapshots(pi).filter((snapshot): snapshot is LiveSnapshot => snapshot.phase === "streaming");
}

/** The current snapshot, asked for on `pi-tps:request` as another extension would. */
export function requestSnapshot(pi: Pi): StatusSnapshot | undefined {
	pi.events.emit(REQUEST, undefined);
	return snapshots(pi).at(-1);
}

export function lastIdle(pi: Pi): IdleSnapshot | undefined {
	return snapshots(pi)
		.filter((snapshot): snapshot is IdleSnapshot => snapshot.phase === "idle")
		.at(-1);
}

/** Run records persisted as `pi-tps` custom entries on the session. */
export function persistedRuns(pi: Pi): unknown[] {
	return pi
		.entries()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === ENTRY_TYPE ? [entry.data] : []));
}

/** A rate within ±30% of the scripted one: wide enough for scheduler delay on a slow runner (design D4). */
export function expectNear(value: number | undefined, target: number): void {
	expect(value).toBeGreaterThanOrEqual(target * 0.7);
	expect(value).toBeLessThanOrEqual(target * 1.3);
}
