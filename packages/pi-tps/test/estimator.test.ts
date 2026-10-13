import { describe, expect, it } from "vitest";
import { createDeltaEstimator, estimateTokens, StreamEstimator } from "../src/estimator.ts";

// Reference counts were produced once with gpt-tokenizer (o200k_base and cl100k_base); they stand in for
// the output tokens a provider would report for the same text.
const ENGLISH =
	"The measurement core is driven by normalised inputs and an injectable clock, so it can be tested with synthetic delta timelines. Each delta is estimated once when it arrives, and the running totals are kept as prefix sums so that the live window never re-reads earlier text. When the provider reports usage at the end of the request, the estimate is calibrated against it.";
const ENGLISH_REFERENCE = [73, 74];

const CHINESE =
	"流式输出时，扩展会估算每个增量的令牌数，并在请求结束时用服务商报告的用量进行校准。这样即使模型使用不同的分词器，实时速度也能保持接近真实值。如果代理先缓存整段回复再一次性发送，读数会标记为突发传输，而不是显示一个虚高的生成速度。";
const CHINESE_REFERENCE = [86, 112];

const TOOL_ARGUMENTS =
	'{"path":"packages/pi-tps/src/measurement.ts","edits":[{"oldText":"const window = 5000;","newText":"const window = LIVE_WINDOW_MS;"}],"dryRun":false}';
const TOOL_ARGUMENTS_REFERENCE = [44, 43];

const TOLERANCE = 0.3;

function chunks(text: string, size: number): string[] {
	const characters = Array.from(text);
	const out: string[] = [];
	for (let i = 0; i < characters.length; i += size) out.push(characters.slice(i, i + size).join(""));
	return out;
}

function streamed(deltas: string[]): number {
	const estimator = new StreamEstimator();
	return deltas.reduce((sum, delta) => sum + estimator.add(delta), 0);
}

function expectWithinTolerance(estimate: number, references: number[]): void {
	for (const reference of references) {
		expect(Math.abs(estimate - reference) / reference).toBeLessThanOrEqual(TOLERANCE);
	}
}

describe("estimateTokens", () => {
	it("returns 0 for empty input", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it.each([
		["English prose", ENGLISH, ENGLISH_REFERENCE],
		["Chinese prose", CHINESE, CHINESE_REFERENCE],
		["JSON tool arguments", TOOL_ARGUMENTS, TOOL_ARGUMENTS_REFERENCE],
	])("estimates %s within 30 %% of provider counts", (_name, text, references) => {
		expectWithinTolerance(estimateTokens(text), references);
	});
});

describe("StreamEstimator", () => {
	it("counts an empty delta as 0", () => {
		expect(new StreamEstimator().add("")).toBe(0);
	});

	it("keeps English deltas that split words within 30 %", () => {
		expectWithinTolerance(streamed(chunks(ENGLISH, 4)), ENGLISH_REFERENCE);
		expectWithinTolerance(streamed(chunks(ENGLISH, 1)), ENGLISH_REFERENCE);
	});

	it("keeps Chinese deltas within 30 %", () => {
		expectWithinTolerance(streamed(chunks(CHINESE, 2)), CHINESE_REFERENCE);
		expectWithinTolerance(streamed(chunks(CHINESE, 1)), CHINESE_REFERENCE);
	});

	it("keeps JSON tool-argument deltas within 30 %", () => {
		expectWithinTolerance(streamed(chunks(TOOL_ARGUMENTS, 6)), TOOL_ARGUMENTS_REFERENCE);
	});

	it("matches the whole-text estimate for word-aligned English deltas", () => {
		expect(streamed(ENGLISH.split(/(?<= )/))).toBe(estimateTokens(ENGLISH));
	});
});

describe("StreamEstimator chunk stability", () => {
	const samples: [string, string][] = [
		["a long digit run", "1234567890".repeat(100)],
		["a long identifier", "someVeryLongIdentifierName_".repeat(40)],
		["a punctuation run", "-=*#".repeat(150)],
		["English prose", ENGLISH.repeat(3)],
		["Chinese prose", CHINESE.repeat(3)],
		["JSON tool arguments", TOOL_ARGUMENTS.repeat(5)],
	];

	it.each(samples)("keeps %s within 2 %% of the whole-text estimate for any delta size", (_name, text) => {
		const whole = estimateTokens(text);
		for (const size of [1, 2, 3, 4, 7, 16, 128, 1000]) {
			const total = streamed(chunks(text, size));
			expect(Math.abs(total - whole)).toBeLessThanOrEqual(Math.max(2, whole * 0.02));
		}
	});
});

describe("createDeltaEstimator", () => {
	it("keeps a separate context per stream", () => {
		const estimator = createDeltaEstimator();
		const thinking = estimator.add("thinking", "consider");
		const text = estimator.add("text", "consider");
		expect(text).toBe(thinking);
	});
});
