import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Pi, reply, startPi, tokens } from "../../../tools/e2e/src/index.ts";
import { streaming } from "./fixtures.ts";

const WORKER = join(import.meta.dirname, "calibration-worker.ts");
const KEY = "scripted/a";

let agentDir: string;
let pi: Pi | undefined;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-tps-calibration-"));
});

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
	await rm(agentDir, { recursive: true, force: true });
});

function calibrationDir(): string {
	return join(agentDir, "pi-tps-calibration");
}

/** The output calibration of the scripted model in the newest version file. */
async function newestOutputRatio(): Promise<{ ratio: number; samples: number } | undefined> {
	const newest = (await readdir(calibrationDir()))
		.filter((name) => /^\d{10}\.json$/.test(name))
		.sort()
		.at(-1);
	if (newest === undefined) return undefined;
	const file: unknown = JSON.parse(await readFile(join(calibrationDir(), newest), "utf8"));
	if (typeof file !== "object" || file === null || !("models" in file)) return undefined;
	const { models } = file;
	if (typeof models !== "object" || models === null || !(KEY in models)) return undefined;
	const entry: unknown = Object.entries(models).find(([key]) => key === KEY)?.[1];
	if (typeof entry !== "object" || entry === null || !("output" in entry)) return undefined;
	const { output } = entry;
	if (typeof output !== "object" || output === null || !("ratio" in output) || !("samples" in output)) return undefined;
	const { ratio, samples } = output;
	return typeof ratio === "number" && typeof samples === "number" ? { ratio, samples } : undefined;
}

/** 200 streamed tokens that the provider reports as 400: a calibrating request with a ratio of 2. */
const doubled = () => reply(tokens(200, { tokensPerSecond: 200 }), { usage: { output: 400 } });

/** The largest live output count of the session's streaming snapshots: its estimate at the end of the stream. */
function liveOutput(session: Pi): number {
	return Math.max(...streaming(session).map((snapshot) => snapshot.outputTokens));
}

describe("calibration", () => {
	// token-estimation: Calibration persists across sessions.
	it("carries a learned ratio into the next session's live counts", async () => {
		pi = await startPi({ extensions: ["pi-tps"], agentDir });
		pi.provider.respond(doubled());
		await pi.prompt("first session");
		const first = liveOutput(pi);
		await pi.dispose();
		pi = undefined;
		const stored = await newestOutputRatio();
		expect(stored?.ratio).toBeGreaterThanOrEqual(1.8);
		expect(stored?.ratio).toBeLessThanOrEqual(2.2);

		pi = await startPi({ extensions: ["pi-tps"], agentDir });
		pi.provider.respond(doubled());
		await pi.prompt("second session");
		const ratio = liveOutput(pi) / first;
		expect(ratio).toBeGreaterThanOrEqual(1.5);
		expect(ratio).toBeLessThanOrEqual(2.5);
	});

	// token-estimation: Calibration is shared by concurrent sessions.
	it("keeps every sample when two Pi processes calibrate at the same time", async () => {
		const count = 10;
		const run = promisify(execFile);
		// Both workers start their requests at the same moment, after their sessions have started.
		const startAt = String(Date.now() + 3000);
		await Promise.all([1, 2].map(() => run(process.execPath, [WORKER, agentDir, String(count), startAt])));
		expect((await newestOutputRatio())?.samples).toBe(2 * count);
	});

	// token-estimation: Calibration can be disabled.
	it("writes nothing to the agent directory when calibration is off", async () => {
		pi = await startPi({ extensions: ["pi-tps"], agentDir, agentFiles: { "pi-tps.json": { calibration: false } } });
		pi.provider.respond(doubled());
		await pi.prompt("go");
		await pi.dispose();
		pi = undefined;
		expect(existsSync(calibrationDir())).toBe(false);
	});
});
