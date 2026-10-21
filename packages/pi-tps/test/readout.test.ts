import { afterEach, describe, expect, it } from "vitest";
import { type Pi, pause, plainStatus, reply, startPi, tokens, waitFor } from "../../../tools/e2e/src/index.ts";
import { requestRecords, snapshots, streaming } from "./fixtures.ts";

const KEY = "pi-tps";
const SPINNER = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

let pi: Pi | undefined;

afterEach(async () => {
	await pi?.dispose();
	pi = undefined;
});

describe("footer readout", () => {
	// tps-readout: Readout phases, Idle readout shows session totals, /tps command toggles visibility.
	// request-measurement: Aborted requests.
	it("moves the footer through its phases, marks an aborted run, and hides and restores on /tps", async () => {
		pi = await startPi({ extensions: ["pi-tps"], mode: "tui" });
		const session = pi;
		session.provider.respond(reply([pause(300), tokens(250, { tokensPerSecond: 100 })]));
		await session.prompt("go");

		const lines = plainStatus(session.ui, KEY);
		expect(lines.some((line) => new RegExp(`^${SPINNER} .*TTFT \\d`).test(line))).toBe(true);
		expect(lines.some((line) => new RegExp(`^${SPINNER} \\d+(\\.\\d)? .*TPS`).test(line))).toBe(true);
		const idle = lines.at(-1) ?? "";
		expect(idle).toMatch(/^✓ /);
		expect(idle).toContain("1 run in");
		expect(idle).toContain("↓");

		session.provider.respond(reply(tokens(500, { tokensPerSecond: 100 })));
		const before = streaming(session).length;
		const run = session.prompt("again");
		await waitFor("the second request to stream", () => streaming(session).length > before);
		await session.session.abort();
		await run;
		expect(plainStatus(session.ui, KEY).at(-1)).toMatch(/^✗ /);
		expect(requestRecords(session).at(-1)?.outcome).toBe("aborted");

		await session.prompt("/tps");
		expect(session.ui.currentStatus(KEY)).toBeUndefined();
		await session.prompt("/tps");
		expect(plainStatus(session.ui, KEY).at(-1)).toMatch(/^✗ /);
	});

	// tps-readout: Non-TUI modes write nothing to the UI.
	it("writes no footer in RPC mode but still broadcasts its snapshots", async () => {
		pi = await startPi({ extensions: ["pi-tps"], mode: "rpc" });
		pi.provider.respond(reply(tokens(50, { tokensPerSecond: 200 })));
		await pi.prompt("go");
		expect(pi.ui.status(KEY)).toEqual([]);
		expect(snapshots(pi).length).toBeGreaterThan(1);
		expect(requestRecords(pi)).toHaveLength(1);
	});
});
