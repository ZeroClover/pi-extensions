import { describe, expect, it } from "vitest";
import { classifyBurst, countBatches, type DeltaTimeline, largestClusterShare } from "../src/burst.ts";

function timeline(entries: [number, number][]): DeltaTimeline {
	return { at: entries.map(([at]) => at), tokens: entries.map(([, tokens]) => tokens) };
}

function evenly(count: number, gapMs: number, tokens: number, startAt = 0): [number, number][] {
	return Array.from({ length: count }, (_, i): [number, number] => [startAt + i * gapMs, tokens]);
}

describe("classifyBurst", () => {
	it("does not mark a short response in few batches", () => {
		expect(classifyBurst(timeline(evenly(3, 200, 4)), 12)).toBeUndefined();
		expect(classifyBurst(timeline([]), 49)).toBeUndefined();
		expect(classifyBurst(timeline([]), 50)).toBe("few-batches");
	});

	it("marks fewer than 5 batches", () => {
		expect(classifyBurst(timeline(evenly(3, 200, 300)), 900)).toBe("few-batches");
	});

	it("marks deltas 0.3 ms apart as one batch", () => {
		expect(classifyBurst(timeline(evenly(40, 0.3, 5)), 200)).toBe("few-batches");
	});

	it("does not mark several events per network read", () => {
		const entries = Array.from({ length: 60 }, (_, batch) => evenly(5, 0.02, 1, batch * 50)).flat();
		expect(classifyBurst(timeline(entries), 1000, 100)).toBeUndefined();
	});

	it("marks a 100 ms cluster carrying half of the tokens", () => {
		const entries = [...evenly(20, 100, 5), ...evenly(5, 10, 40, 2500)];
		expect(classifyBurst(timeline(entries), 1000, 1000)).toBe("cluster");
	});

	it("marks an implausible rate", () => {
		expect(classifyBurst(timeline(evenly(50, 20, 5)), 1000, 25_000)).toBe("rate");
	});

	it("marks a proxy flush after a stall that follows normal streaming", () => {
		const normal = evenly(10, 100, 5);
		const flush = evenly(10, 0.2, 10, 900 + 6000);
		expect(classifyBurst(timeline([...normal, ...flush]), 1000, 1000)).toBe("cluster");
	});

	it("does not mark genuine fast streaming", () => {
		expect(classifyBurst(timeline(evenly(300, 3, 2)), 1000, 220)).toBeUndefined();
	});

	it("judges the output stream by its own token count (chunked summary then a tool call)", () => {
		// With the summary chunks in the timeline the request reads as burst; the output stream alone does not.
		expect(classifyBurst(timeline([2000, 6000, 11000, 12000].map((at) => [at, 20])), 80)).toBe("few-batches");
		expect(classifyBurst(timeline([[12000, 20]]), 20, 150)).toBeUndefined();
	});

	it("still marks a request without output deltas whose reported output is large (successful request without deltas)", () => {
		expect(classifyBurst(timeline([]), 120)).toBe("few-batches");
	});

	it("leaves the phase-opening backlog out of the cluster search (backlog when the answer starts)", () => {
		const backlog = evenly(20, 5, 20);
		const rest = evenly(25, 80, 10, 180);
		const entries = [...backlog, ...rest];
		const marked = { ...timeline(entries), backlog: entries.map(([at]) => at <= 300) };
		expect(classifyBurst(timeline(entries), 650, 300)).toBe("cluster");
		expect(classifyBurst(marked, 650, 300)).toBeUndefined();
	});

	it("still marks a flush after a stall that follows normal streaming (flush after normal streaming)", () => {
		const entries = [...evenly(10, 100, 10), ...evenly(6, 10, 50, 6900)];
		const marked = { ...timeline(entries), backlog: entries.map(([at]) => at <= 300) };
		expect(classifyBurst(marked, 400, 100)).toBe("cluster");
	});

	it("does not apply the cluster rule to streams of 1 s or less", () => {
		const entries = [...evenly(5, 100, 1), [450, 100] as [number, number]];
		expect(classifyBurst(timeline(entries), 1000, 1000)).toBeUndefined();
	});
});

describe("countBatches", () => {
	it("groups deltas less than 1 ms apart", () => {
		expect(countBatches([])).toBe(0);
		expect(countBatches([0, 0.1, 0.5, 2, 2.9, 10])).toBe(3);
	});
});

describe("largestClusterShare", () => {
	it("is 0 without tokens", () => {
		expect(largestClusterShare(timeline([]))).toBe(0);
	});

	it("finds the densest window", () => {
		expect(largestClusterShare(timeline([...evenly(4, 1000, 1), [3050, 4]]))).toBe(5 / 8);
	});

	it("searches outside the backlog windows and divides by all tokens (several short output phases)", () => {
		const entries = [...evenly(5, 100, 10), ...evenly(5, 100, 10, 2500)];
		const backlog = entries.map(([at]) => at <= 300 || (at >= 2500 && at <= 2800));
		expect(largestClusterShare(timeline(entries))).toBe(0.2);
		expect(largestClusterShare({ ...timeline(entries), backlog })).toBe(0.1);
	});
});
