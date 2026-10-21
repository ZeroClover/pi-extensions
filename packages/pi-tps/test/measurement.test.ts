import { afterEach, describe, expect, it } from "vitest";
import { hiddenThinking, type Pi, pause, reply, startPi, thinking, tokens } from "../../../tools/e2e/src/index.ts";
import { expectNear, lastIdle, persistedRuns, requestRecords, runRecords, streaming } from "./fixtures.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

async function start(): Promise<Pi> {
	pi = await startPi({ extensions: ["pi-tps"] });
	return pi;
}

describe("request measurement", () => {
	// request-measurement: Time to first token, Live output TPS over a sliding window, Settlement from provider usage.
	// telemetry-history: Telemetry is persisted per run, Telemetry records are broadcast.
	it("shows the live speed while streaming, and settles, persists, and broadcasts the right speed and TTFT", async () => {
		const session = await start();
		session.provider.respond(reply([pause(300), tokens(300, { tokensPerSecond: 100 })]));
		await session.prompt("go");

		const live = streaming(session);
		const lastSecond = live.filter((snapshot) => snapshot.elapsedMs >= 2300);
		expect(lastSecond.length).toBeGreaterThan(3);
		for (const snapshot of lastSecond) expectNear(snapshot.liveTps, 100);
		const ttfts = new Set(live.map((snapshot) => snapshot.ttftMs));
		expect(ttfts.size).toBe(1);
		expect([...ttfts][0]).toBeGreaterThanOrEqual(300);

		const [record, ...others] = requestRecords(session);
		expect(others).toEqual([]);
		expect(record?.outcome).toBe("settled");
		expectNear(record?.tps, 100);
		expect(record?.ttftMs).toBeGreaterThanOrEqual(300);
		expect(record?.outputTokens).toBe(300);

		const runs = runRecords(session);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.requests).toEqual([record]);
		expect(persistedRuns(session)).toEqual(runs);
	});

	// request-measurement: Thinking and output are measured separately.
	it("counts thinking time in the generation rate instead of folding it into TTFT or dropping it", async () => {
		const session = await start();
		session.provider.respond(
			reply([thinking(200, { tokensPerSecond: 100 }), tokens(100, { tokensPerSecond: 100 })], {
				usage: { output: 300, reasoning: 200 },
			}),
			reply([hiddenThinking(1000), tokens(100, { tokensPerSecond: 100 })]),
		);
		await session.prompt("streamed thinking");
		await session.prompt("hidden thinking");

		const [streamed, hidden] = requestRecords(session);
		expect(streamed?.thinking).toBe("streamed");
		expect(streamed?.thinkingMs).toBeGreaterThanOrEqual(1800);
		expect(streamed?.ttftMs).toBeLessThan(1000);
		// 300 tokens over 2 s of thinking and 1 s of output.
		expectNear(streamed?.tps, 100);
		expect(hidden?.thinking).toBe("hidden");
		expect(hidden?.thinkingMs).toBeGreaterThanOrEqual(900);
	});

	// request-measurement: Burst detection, Burst requests do not feed calibration or TPS aggregates.
	it("keeps a buffered flush out of the TPS average", async () => {
		const session = await start();
		session.provider.respond(reply([pause(1500), tokens(300)]));
		await session.prompt("flush");

		const [record] = requestRecords(session);
		expect(record?.burst).toBe(true);
		expect(record?.tps).toBeUndefined();
		const average = lastIdle(session)?.average;
		expect(average?.burstTps).toBeGreaterThan(0);
		expect(average?.tps).toBeUndefined();
	});

	// request-measurement: Stall detection.
	it("excludes a mid-stream network stall from the settled rate", async () => {
		const session = await start();
		session.provider.respond(
			reply([tokens(150, { tokensPerSecond: 100 }), pause(1500), tokens(150, { tokensPerSecond: 100 })]),
		);
		await session.prompt("stall");

		const [record] = requestRecords(session);
		expect(record?.burst).toBe(false);
		expect(record?.stallCount).toBe(1);
		expect(record?.stallMs).toBeGreaterThanOrEqual(1350);
		expectNear(record?.tps, 100);
	});
});
