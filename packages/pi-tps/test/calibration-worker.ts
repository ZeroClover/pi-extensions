// Started with plain `node` by calibration.test.ts: one Pi session in its own process that settles `count`
// calibrating requests against the shared agent directory given as the first argument. The requests start at the
// wall-clock time `startAt`, so that concurrent workers publish in lockstep and their publications collide.
import { reply, startPi, tokens } from "../../../tools/e2e/src/index.ts";

const [agentDir, countText, startAtText] = process.argv.slice(2);
if (agentDir === undefined || countText === undefined || startAtText === undefined) {
	throw new Error("usage: node calibration-worker.ts <agent-dir> <count> <start-at-ms>");
}
const pi = await startPi({ extensions: ["pi-tps"], agentDir, mode: "rpc" });
try {
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAtText) - Date.now())));
	for (let i = 0; i < Number(countText); i++) {
		// 60 streamed tokens, reported as 120: a calibrating sample with a ratio of 2.
		pi.provider.respond(reply(tokens(60, { tokensPerSecond: 600 }), { usage: { output: 120 } }));
		await pi.prompt(`request ${i}`);
	}
} finally {
	await pi.dispose();
}
