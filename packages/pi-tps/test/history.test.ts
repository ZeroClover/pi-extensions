import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failure, type Pi, reply, startPi, tokens } from "../../../tools/e2e/src/index.ts";
import { ENTRY_TYPE, lastIdle, requestRecords, requestSnapshot, runRecords } from "./fixtures.ts";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

/** A request long enough (1.5 s of generation) to feed the TPS average. */
const measurable = () => reply(tokens(150, { tokensPerSecond: 100 }));

/** The models of the newest calibration version in the agent directory. */
async function calibrationModels(agentDir: string): Promise<Record<string, unknown>> {
	const dir = join(agentDir, "pi-tps-calibration");
	const newest = (await readdir(dir))
		.filter((name) => name.endsWith(".json"))
		.sort()
		.at(-1);
	if (newest === undefined) throw new Error(`no calibration version in ${dir}`);
	const parsed: unknown = JSON.parse(await readFile(join(dir, newest), "utf8"));
	if (typeof parsed !== "object" || parsed === null || !("models" in parsed)) throw new Error("no models");
	const { models } = parsed;
	if (typeof models !== "object" || models === null) throw new Error("no models");
	return { ...models };
}

describe("telemetry history", () => {
	// telemetry-history: Reconstruction on session start and branch change.
	it("restores the session totals on resume and follows the branch on navigation", async () => {
		pi = await startPi({ extensions: ["pi-tps"], session: { file: true } });
		pi.provider.respond(measurable(), measurable());
		await pi.prompt("first");
		const firstRunEnd = pi.entries().findLast((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE);
		await pi.prompt("second");

		pi = await pi.reopen();
		const resumed = requestSnapshot(pi);
		expect(resumed?.phase).toBe("idle");
		expect(resumed?.phase === "idle" && resumed.session?.runs).toBe(2);
		expect(resumed?.average.tps).toBeGreaterThan(0);

		if (firstRunEnd === undefined) throw new Error("the first run left no pi-tps entry");
		await pi.session.navigateTree(firstRunEnd.id);
		const branched = requestSnapshot(pi);
		expect(branched?.phase === "idle" && branched.session?.runs).toBe(1);
	});

	// telemetry-history: Persistence can be disabled.
	it("keeps runs out of the session file when persistence is off", async () => {
		pi = await startPi({
			extensions: ["pi-tps"],
			session: { file: true },
			agentFiles: { "pi-tps.json": { persist: false } },
		});
		pi.provider.respond(measurable());
		await pi.prompt("go");
		expect(runRecords(pi)).toHaveLength(1);
		expect(pi.entries().filter((entry) => entry.type === "custom")).toEqual([]);

		pi = await pi.reopen();
		const resumed = requestSnapshot(pi);
		expect(resumed?.phase === "idle" && resumed.session).toBeUndefined();
	});

	// request-measurement: Errored and deferred requests, A run spans one agent run until Pi settles.
	it("does not count an attempt that Pi's own retry replaced, nor end the run on it", async () => {
		pi = await startPi({
			extensions: ["pi-tps"],
			settings: { retry: { enabled: true, baseDelayMs: 100, maxRetries: 2 } },
		});
		pi.provider.respond(failure("503 Service Unavailable", { status: 503 }), measurable());
		await pi.prompt("go");
		expect(pi.provider.requests).toHaveLength(2);
		const runs = runRecords(pi);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.requests).toHaveLength(1);
		expect(requestRecords(pi).map((record) => record.outcome)).toEqual(["settled"]);
	});

	// telemetry-history: Records name the selected model. token-estimation: Model identity.
	// tps-readout: Averages follow the current model.
	it("attributes virtual-model traffic to the serving model and shows the selected model's averages when idle", async () => {
		pi = await startPi({ extensions: ["pi-tps"] });
		pi.provider.respond(reply(tokens(150, { tokensPerSecond: 100 }), { model: "served" }));
		await pi.prompt("go");

		const [record] = requestRecords(pi);
		expect(record?.model).toBe("served");
		expect(record?.requested).toEqual({ provider: "scripted", model: "a" });
		const calibrated = Object.keys(await calibrationModels(pi.agentDir));
		expect(calibrated).toContain("scripted/served");
		expect(calibrated).not.toContain("scripted/a");
		expect(lastIdle(pi)?.average.tps).toBeGreaterThan(0);

		await pi.session.setModel(pi.provider.models[1]);
		expect(lastIdle(pi)?.average).toEqual({});
	});
});
