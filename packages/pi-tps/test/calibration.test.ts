import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CalibrationStore,
	calibrationKey,
	calibrationKeys,
	isCalibratable,
	nextEntry,
	nextRatio,
	openCalibration,
	parseCalibration,
	WRITER_RETENTION_MS,
} from "../src/calibration.ts";
import { type FileLayer, nodeFiles } from "../src/files.ts";
import { Measurement } from "../src/measurement.ts";

const DIR = "/agent/pi-tps-calibration";

function version(n: number): string {
	return join(DIR, `${String(n).padStart(10, "0")}.json`);
}

/** A version-2 file whose models carry an output ratio each. */
function file(models: Record<string, { ratio: number; samples: number; updatedAt: number }>): string {
	const entries = Object.fromEntries(Object.entries(models).map(([key, output]) => [key, { output }]));
	return JSON.stringify({ version: 2, models: entries });
}

/** An in-memory directory. `beforePublish` runs once inside the next publish, before the exclusive check. */
class MemoryDir implements FileLayer {
	readonly files = new Map<string, string>();
	beforePublish: (() => void) | undefined;
	/** Runs once right after the next successful creation, before publish returns. */
	afterPublish: (() => void) | undefined;
	failPublish: Error | undefined;
	/** Thrown by the next publish after it created the file, as when removing the temporary file fails. */
	failAfterCreating: Error | undefined;
	failRemove: Error | undefined;
	publishes = 0;

	read(path: string): string | undefined {
		return this.files.get(path);
	}

	list(dir: string): string[] {
		return [...this.files.keys()]
			.filter((path) => path.startsWith(`${dir}/`))
			.map((path) => path.slice(dir.length + 1));
	}

	publish(path: string, content: string): boolean {
		const hook = this.beforePublish;
		this.beforePublish = undefined;
		hook?.();
		if (this.failPublish) throw this.failPublish;
		if (this.files.has(path)) return false;
		this.publishes++;
		this.files.set(path, content);
		const after = this.afterPublish;
		this.afterPublish = undefined;
		after?.();
		const failure = this.failAfterCreating;
		this.failAfterCreating = undefined;
		if (failure) throw failure;
		return true;
	}

	remove(path: string): void {
		if (this.failRemove) throw this.failRemove;
		this.files.delete(path);
	}
}

function store(dir: MemoryDir, clock?: () => number): CalibrationStore {
	const result = clock ? new CalibrationStore(DIR, dir, clock) : new CalibrationStore(DIR, dir);
	result.load();
	return result;
}

describe("CalibrationStore on a real directory", () => {
	it("republishes a sample whose creation hit a reused version number (writer paused across several publishes)", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-tps-calibration-"));
		const dir = join(root, "pi-tps-calibration");
		try {
			let pause: (() => void) | undefined;
			const pausing: FileLayer = {
				read: (path) => nodeFiles.read(path),
				list: (path) => nodeFiles.list(path),
				remove: (path) => nodeFiles.remove(path),
				publish: (path, content) => {
					const hook = pause;
					pause = undefined;
					hook?.();
					return nodeFiles.publish(path, content);
				},
			};
			const seed = new CalibrationStore(dir, nodeFiles);
			seed.load();
			seed.update("p/seed", "output", { reported: 100, estimated: 100 }, 0);
			const paused = new CalibrationStore(dir, pausing);
			paused.load();
			const other = new CalibrationStore(dir, nodeFiles);
			other.load();
			pause = () => {
				for (let i = 0; i < 4; i++) other.update("p/b", "output", { reported: 100 + i, estimated: 100 }, i);
			};
			paused.update("p/a", "output", { reported: 200, estimated: 100 }, 10);
			const restored = new CalibrationStore(dir, nodeFiles);
			restored.load();
			expect(restored.entry("p/a")).toEqual({ output: { ratio: 2, samples: 1, updatedAt: 10 } });
			expect(restored.entry("p/b")?.output?.samples).toBe(4);
			expect(restored.ratios("p/seed").output).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("calibrationKey", () => {
	it("joins provider and model", () => {
		expect(calibrationKey("anthropic", "claude-sonnet-4")).toBe("anthropic/claude-sonnet-4");
	});

	it("stores under the response model and the requested model", () => {
		expect(calibrationKeys("openai", "gpt-4o", "gpt-4o-2024-08-06")).toEqual([
			"openai/gpt-4o-2024-08-06",
			"openai/gpt-4o",
		]);
		expect(calibrationKeys("openai", "gpt-4o")).toEqual(["openai/gpt-4o"]);
	});
});

describe("nextRatio", () => {
	it("sets the ratio directly from the first sample", () => {
		expect(nextRatio("output", undefined, { reported: 1000, estimated: 800 }, 1).ratio).toBe(1.25);
	});

	it("moves toward a new ratio without jumping to it", () => {
		const entry = nextRatio(
			"output",
			{ ratio: 1.25, samples: 1, updatedAt: 0 },
			{ reported: 1000, estimated: 1000 },
			1,
		);
		expect(entry.ratio).toBeLessThan(1.25);
		expect(entry.ratio).toBeGreaterThan(1);
		expect(entry.samples).toBe(2);
	});

	it("converges after repeated samples", () => {
		let entry = nextRatio("output", undefined, { reported: 1250, estimated: 1000 }, 0);
		for (let i = 0; i < 20; i++) entry = nextRatio("output", entry, { reported: 1000, estimated: 1000 }, i);
		expect(entry.ratio).toBeCloseTo(1, 2);
	});

	it("clamps outliers", () => {
		expect(nextRatio("output", undefined, { reported: 900, estimated: 100 }, 0).ratio).toBe(4);
		expect(nextRatio("output", undefined, { reported: 10, estimated: 100 }, 0).ratio).toBe(0.25);
	});

	it("clamps an outlier sample before averaging it into an existing ratio", () => {
		const entry = nextRatio("output", { ratio: 1, samples: 3, updatedAt: 0 }, { reported: 900, estimated: 100 }, 1);
		expect(entry.ratio).toBeCloseTo(1.9);
	});
});

describe("thinking ratio", () => {
	it("samples a full chain of thought near 1 (full chain of thought)", () => {
		expect(nextRatio("thinking", undefined, { reported: 1000, estimated: 950 }, 0).ratio).toBeCloseTo(1.05, 2);
	});

	it("samples a summary far above the output clamp (summary)", () => {
		expect(nextRatio("thinking", undefined, { reported: 6000, estimated: 120 }, 0).ratio).toBe(50);
	});

	it("clamps at 100 (summary far shorter than the clamp allows)", () => {
		expect(nextRatio("thinking", undefined, { reported: 20_000, estimated: 100 }, 0).ratio).toBe(100);
		expect(nextRatio("thinking", undefined, { reported: 10, estimated: 100 }, 0).ratio).toBe(0.25);
	});

	it("leaves the output ratio alone (independent of the output ratio)", () => {
		const output = { ratio: 1.1, samples: 3, updatedAt: 0 };
		const entry = nextEntry({ output }, "thinking", { reported: 800, estimated: 100 }, 1);
		expect(entry).toEqual({ output, thinking: { ratio: 8, samples: 1, updatedAt: 1 } });
	});

	it("is stored and restored next to the output ratio", () => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		calibration.update("p/m", "output", { reported: 110, estimated: 100 }, 1);
		calibration.update("p/m", "thinking", { reported: 800, estimated: 100 }, 2);
		expect(calibration.ratios("p/m")).toEqual({ output: 1.1, thinking: 8 });
		expect(store(dir).ratios("p/m")).toEqual({ output: 1.1, thinking: 8 });
		expect(store(dir).ratios("q/n")).toEqual({ output: undefined, thinking: undefined });
	});
});

describe("isCalibratable", () => {
	it("rejects tiny estimates and missing usage", () => {
		expect(isCalibratable({ reported: 40, estimated: 50 })).toBe(false);
		expect(isCalibratable({ reported: 0, estimated: 500 })).toBe(false);
		expect(isCalibratable({ reported: Number.NaN, estimated: 500 })).toBe(false);
		expect(isCalibratable({ reported: 400, estimated: 51 })).toBe(true);
	});
});

describe("parseCalibration", () => {
	it("skips invalid entries", () => {
		const parsed = parseCalibration(
			JSON.stringify({
				version: 2,
				models: {
					"a/b": { output: { ratio: 1.1, samples: 2, updatedAt: 5 } },
					"c/d": { output: { ratio: "x" } },
					"e/f": { thinking: { ratio: 50, samples: 1, updatedAt: 5 }, output: null },
					"g/h": {},
				},
			}),
		);
		if (parsed.status !== "current") throw new Error(`expected the current format, got ${parsed.status}`);
		expect(parsed.models.get("a/b")?.output?.ratio).toBe(1.1);
		expect(parsed.models.has("c/d")).toBe(false);
		expect(parsed.models.has("e/f")).toBe(false);
		expect(parsed.models.has("g/h")).toBe(false);
		expect(parsed.warning).toContain("3 invalid entries");
	});

	it("marks unparseable content invalid and other format versions as such", () => {
		expect(parseCalibration("{not json").status).toBe("invalid");
		expect(parseCalibration(JSON.stringify({ models: {} })).status).toBe("invalid");
		expect(parseCalibration(JSON.stringify({ version: 2, models: [] })).status).toBe("invalid");
		expect(parseCalibration(JSON.stringify({ version: 1, models: {} }))).toEqual({ status: "other-format" });
	});

	it("clamps the ratios of a file to their kind's range", () => {
		const parsed = parseCalibration(
			JSON.stringify({
				version: 2,
				models: {
					"a/b": {
						output: { ratio: 9, samples: 1, updatedAt: 0 },
						thinking: { ratio: 500, samples: 1, updatedAt: 0 },
					},
				},
			}),
		);
		if (parsed.status !== "current") throw new Error("expected the current format");
		expect(parsed.models.get("a/b")).toMatchObject({ output: { ratio: 4 }, thinking: { ratio: 100 } });
	});
});

describe("CalibrationStore", () => {
	it("treats a missing directory as empty without warning", () => {
		const calibration = new CalibrationStore(DIR, new MemoryDir());
		expect(calibration.load()).toBeUndefined();
		expect(calibration.ratios("a/b").output).toBeUndefined();
	});

	it("publishes numbered versions that a new session restores (restart)", () => {
		const dir = new MemoryDir();
		expect(store(dir).update("a/b", "output", { reported: 1000, estimated: 800 }, 7)).toBeUndefined();
		expect(dir.files.has(version(1))).toBe(true);
		expect(store(dir).entry("a/b")).toEqual({ output: { ratio: 1.25, samples: 1, updatedAt: 7 } });
	});

	it("uses the newest valid version when the newest is corrupt, and publishes past it (corrupt file)", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({ "a/b": { ratio: 1.5, samples: 1, updatedAt: 1 } }));
		dir.files.set(version(2), "{not json");
		const calibration = new CalibrationStore(DIR, dir);
		const warning = calibration.load();
		expect(warning).toContain("invalid JSON");
		expect(warning).toContain(version(2));
		expect(calibration.ratios("a/b").output).toBe(1.5);
		calibration.update("c/d", "output", { reported: 100, estimated: 100 }, 2);
		expect(dir.files.has(version(3))).toBe(true);
	});

	it("ignores a newest version in an older format without a warning and publishes version 2 (older file format)", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({ "a/b": { ratio: 1.5, samples: 1, updatedAt: 1 } }));
		dir.files.set(
			version(2),
			JSON.stringify({ version: 1, models: { "a/b": { ratio: 2, samples: 1, updatedAt: 2 } } }),
		);
		const calibration = new CalibrationStore(DIR, dir);
		expect(calibration.load()).toBeUndefined();
		expect(calibration.ratios("a/b")).toEqual({ output: undefined, thinking: undefined });
		calibration.update("c/d", "output", { reported: 100, estimated: 100 }, 3);
		expect(JSON.parse(dir.files.get(version(3)) ?? "{}")).toMatchObject({
			version: 2,
			models: { "c/d": { output: { ratio: 1, samples: 1 } } },
		});
		expect(store(dir).ratios("a/b").output).toBeUndefined();
	});

	it("warns when the directory cannot be read", () => {
		const dir = new MemoryDir();
		dir.list = () => {
			throw new Error("EACCES");
		};
		expect(new CalibrationStore(DIR, dir).load()).toContain("EACCES");
	});

	it("ignores samples below the minimum estimate", () => {
		const dir = new MemoryDir();
		store(dir).update("a/b", "output", { reported: 30, estimated: 20 }, 0);
		expect(dir.publishes).toBe(0);
	});

	it("keeps both updates when another session publishes first (concurrent sessions)", () => {
		const dir = new MemoryDir();
		const mine = store(dir);
		const other = store(dir);
		dir.beforePublish = () => other.update("x/other", "output", { reported: 900, estimated: 600 }, 1);
		mine.update("x/mine", "output", { reported: 1000, estimated: 800 }, 2);
		const restored = store(dir);
		expect(restored.ratios("x/other").output).toBe(1.5);
		expect(restored.ratios("x/mine").output).toBe(1.25);
		expect(dir.files.has(version(2))).toBe(true);
		expect(mine.ratios("x/other").output).toBe(1.5);
		expect(restored.entry("x/mine")?.output?.samples).toBe(1);
		expect(restored.entry("x/other")?.output?.samples).toBe(1);
	});

	it("republishes a sample whose creation hit a reused version number (writer paused across several publishes)", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({}));
		const paused = store(dir);
		const other = store(dir);
		// Inside the paused session's creation of version 2, the other session publishes versions 2 to 5 and
		// removes versions 1 and 2, so the paused creation of version 2 succeeds on a reused number.
		dir.beforePublish = () => {
			for (let i = 0; i < 4; i++) other.update("p/b", "output", { reported: 100 + i, estimated: 100 }, i);
		};
		expect(paused.update("p/a", "output", { reported: 200, estimated: 100 }, 10)).toBeUndefined();
		const restored = store(dir);
		expect(restored.entry("p/a")).toEqual({ output: { ratio: 2, samples: 1, updatedAt: 10 } });
		expect(restored.entry("p/b")?.output?.samples).toBe(4);
		expect(paused.flush()).toBeUndefined();
		expect(store(dir).entry("p/a")?.output?.samples).toBe(1);
	});

	it.each([512, 513, 1025])("stores a backlog of %i samples exactly once (large backlog)", (count) => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		dir.failPublish = new Error("EIO");
		for (let i = 0; i < count; i++) {
			calibration.update("p/m", "output", { reported: i === 0 ? 400 : 100, estimated: 100 }, i);
		}
		const expected = calibration.entry("p/m")?.output;
		expect(expected?.samples).toBe(count);
		dir.failPublish = undefined;
		expect(calibration.flush()).toBeUndefined();
		const restored = store(dir).entry("p/m")?.output;
		expect(restored).toEqual(expected);
		expect(restored?.updatedAt).toBe(count - 1);
		expect(restored?.ratio).toBeCloseTo(1, 5);
	});

	it("finds its sample stored after pausing past 512 other samples (pause after publishing)", () => {
		const dir = new MemoryDir();
		const paused = store(dir);
		const other = store(dir);
		dir.afterPublish = () => {
			for (let i = 0; i < 512; i++) other.update("p/b", "output", { reported: 100, estimated: 100 }, i);
		};
		expect(paused.update("p/a", "output", { reported: 200, estimated: 100 }, 1)).toBeUndefined();
		paused.flush();
		const restored = store(dir);
		expect(restored.entry("p/a")?.output?.samples).toBe(1);
		expect(restored.entry("p/b")?.output?.samples).toBe(512);
	});

	it("removes the records of sessions gone for more than 7 days (crashed session)", () => {
		const now = 1_000 * WRITER_RETENTION_MS;
		const dir = new MemoryDir();
		const crashed = JSON.stringify({
			version: 2,
			models: {},
			writers: { crashed: { seq: 3, at: now - WRITER_RETENTION_MS - 86_400_000 }, recent: { seq: 1, at: now - 1000 } },
		});
		dir.files.set(version(1), crashed);
		store(dir, () => now).update("p/m", "output", { reported: 100, estimated: 100 }, 1);
		const writers = Object.keys(JSON.parse(dir.files.get(version(2)) ?? "{}").writers);
		expect(writers).not.toContain("crashed");
		expect(writers).toContain("recent");
		expect(writers).toHaveLength(2);
	});

	it("drops samples it can no longer prove unstored instead of applying them twice (session paused beyond the retention)", () => {
		let now = 1_000 * WRITER_RETENTION_MS;
		const clock = () => now;
		const dir = new MemoryDir();
		const paused = store(dir, clock);
		const other = store(dir, clock);
		dir.afterPublish = () => {
			now += WRITER_RETENTION_MS + 86_400_000;
			other.update("p/b", "output", { reported: 100, estimated: 100 }, 2);
		};
		paused.update("p/a", "output", { reported: 200, estimated: 100 }, 1);
		const restored = store(dir, clock);
		expect(restored.entry("p/a")?.output?.samples).toBe(1);
		expect(restored.entry("p/b")?.output?.samples).toBe(1);
		paused.update("p/a", "output", { reported: 200, estimated: 100 }, 3);
		expect(store(dir, clock).entry("p/a")?.output?.samples).toBe(2);
	});

	describe("a failure after the version was created", () => {
		const DAY = 86_400_000;

		/** B stores three samples of ratio 1 (versions 1 to 3); then A stores one sample of 4 while `fail` is set. */
		function setUp(fail: (dir: MemoryDir) => void) {
			let now = 1_000 * WRITER_RETENTION_MS;
			const clock = () => now;
			const dir = new MemoryDir();
			const other = store(dir, clock);
			for (let i = 0; i < 3; i++) other.update("p/m", "output", { reported: 100, estimated: 100 }, i);
			const mine = store(dir, clock);
			fail(dir);
			const warning = mine.update("p/m", "output", { reported: 400, estimated: 100 }, 10);
			dir.failRemove = undefined;
			const advance = (ms: number) => {
				now += ms;
			};
			return { dir, clock, other, mine, warning, advance };
		}

		it("does not apply the samples again after the record expired (cleanup fails after publishing)", () => {
			const { dir, clock, other, mine, warning, advance } = setUp((dir) => {
				dir.failRemove = new Error("EIO");
			});
			expect(warning).toContain("EIO");
			expect(store(dir, clock).entry("p/m")?.output).toMatchObject({ samples: 4, ratio: 1.9 });
			advance(WRITER_RETENTION_MS + DAY);
			other.update("p/other", "output", { reported: 100, estimated: 100 }, 20);
			expect(mine.flush()).toBeUndefined();
			const restored = store(dir, clock);
			expect(restored.entry("p/m")?.output?.samples).toBe(4);
			expect(restored.ratios("p/m").output).toBeCloseTo(1.9);
			expect(restored.entry("p/other")?.output?.samples).toBe(1);
		});

		it("does not apply the samples again when the creation threw after the file existed", () => {
			const { dir, clock, other, mine, warning, advance } = setUp((dir) => {
				dir.failAfterCreating = new Error("EPERM");
			});
			expect(warning).toContain("EPERM");
			advance(WRITER_RETENTION_MS + DAY);
			other.update("p/other", "output", { reported: 100, estimated: 100 }, 20);
			mine.flush();
			expect(store(dir, clock).entry("p/m")?.output).toMatchObject({ samples: 4 });
			expect(store(dir, clock).ratios("p/m").output).toBeCloseTo(1.9);
		});

		it("stores nothing twice when it retries in time", () => {
			const { dir, clock, mine } = setUp((dir) => {
				dir.failRemove = new Error("EIO");
			});
			expect(mine.flush()).toBeUndefined();
			mine.update("p/m", "output", { reported: 100, estimated: 100 }, 11);
			const restored = store(dir, clock).entry("p/m")?.output;
			expect(restored?.samples).toBe(5);
			expect(restored?.ratio).toBeCloseTo(1.63);
		});
	});

	it("removes its own record when the session closes", () => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		calibration.update("p/m", "output", { reported: 100, estimated: 100 }, 1);
		const newest = () => {
			const name = dir.list(DIR).sort().at(-1) ?? "";
			return JSON.parse(dir.files.get(join(DIR, name)) ?? "{}");
		};
		expect(Object.keys(newest().writers)).toHaveLength(1);
		expect(calibration.close()).toBeUndefined();
		expect(Object.keys(newest().writers)).toHaveLength(0);
		expect(newest().models["p/m"].output.samples).toBe(1);
	});

	it("never applies a stored sample twice when it retries", () => {
		const dir = new MemoryDir();
		const mine = store(dir);
		mine.update("p/a", "output", { reported: 200, estimated: 100 }, 1);
		mine.flush();
		mine.update("p/a", "output", { reported: 200, estimated: 100 }, 2);
		expect(store(dir).entry("p/a")?.output?.samples).toBe(2);
	});

	it("applies an unpublished sample on top of another session's sample for the same model", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({ "p/m": { ratio: 1, samples: 1, updatedAt: 0 } }));
		const mine = store(dir);
		const other = store(dir);
		dir.failPublish = new Error("EIO");
		expect(mine.update("p/m", "output", { reported: 200, estimated: 100 }, 1)).toContain("EIO");
		dir.failPublish = undefined;
		other.update("p/m", "output", { reported: 300, estimated: 100 }, 2);
		expect(store(dir).entry("p/m")).toEqual({ output: { ratio: 1.6, samples: 2, updatedAt: 2 } });
		mine.update("q/n", "output", { reported: 100, estimated: 100 }, 3);
		const restored = store(dir);
		expect(restored.entry("p/m")?.output?.samples).toBe(3);
		expect(restored.ratios("p/m").output).toBeCloseTo(1.72);
		expect(restored.ratios("q/n").output).toBe(1);
	});

	it("publishes a queued sample at shutdown when no later update comes (no later update)", () => {
		const dir = new MemoryDir();
		const mine = store(dir);
		dir.failPublish = new Error("EIO");
		mine.update("a/b", "output", { reported: 200, estimated: 100 }, 1);
		expect(store(dir).ratios("a/b").output).toBeUndefined();
		dir.failPublish = undefined;
		expect(mine.flush()).toBeUndefined();
		expect(store(dir).ratios("a/b").output).toBe(2);
	});

	it("keeps converging in memory and warns once when every write fails (unwritable file)", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({ "x/m": { ratio: 1, samples: 1, updatedAt: 0 } }));
		const calibration = store(dir);
		dir.failPublish = new Error("EROFS");
		const warnings: (string | undefined)[] = [];
		const ratios: number[] = [];
		for (let i = 1; i <= 3; i++) {
			warnings.push(calibration.update("x/m", "output", { reported: 200, estimated: 100 }, i));
			ratios.push(calibration.ratios("x/m").output ?? 0);
		}
		expect(warnings.filter(Boolean)).toHaveLength(1);
		expect(warnings[0]).toContain("EROFS");
		expect(ratios[0]).toBeCloseTo(1.3);
		expect(ratios[1]).toBeCloseTo(1.51);
		expect(ratios[2]).toBeCloseTo(1.657);
		expect(calibration.entry("x/m")?.output?.samples).toBe(4);
	});

	it("keeps the sample queued when every publish attempt loses the race", () => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		dir.publish = () => false;
		expect(calibration.update("a/b", "output", { reported: 200, estimated: 100 }, 1)).toBeUndefined();
		expect(calibration.ratios("a/b").output).toBe(2);
	});

	it("keeps only the newest three versions", () => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		for (let i = 1; i <= 6; i++) calibration.update("a/b", "output", { reported: 100 + i, estimated: 100 }, i);
		expect(dir.list(DIR).sort()).toEqual(["0000000004.json", "0000000005.json", "0000000006.json"]);
	});
});

/** A directory that counts every access. */
class WatchedDir extends MemoryDir {
	accesses = 0;

	override read(path: string): string | undefined {
		this.accesses++;
		return super.read(path);
	}

	override list(dir: string): string[] {
		this.accesses++;
		return super.list(dir);
	}

	override publish(path: string, content: string): boolean {
		this.accesses++;
		return super.publish(path, content);
	}

	override remove(path: string): void {
		this.accesses++;
		super.remove(path);
	}
}

describe("openCalibration", () => {
	it("neither reads nor writes while disabled and uses a factor of 1 (calibration off)", () => {
		const dir = new WatchedDir();
		dir.files.set(version(1), file({ "p/m": { ratio: 2, samples: 5, updatedAt: 1 } }));
		const before = new Map(dir.files);
		const { calibration, warning } = openCalibration(false, DIR, dir);
		expect(warning).toBeUndefined();
		let t = 0;
		const meter = new Measurement({ now: () => t }, () => ({ add: (_stream, delta) => delta.length }));
		for (let i = 0; i < 10; i++) {
			meter.turnStart();
			meter.requestStart({ provider: "p", model: "m", ratios: calibration.ratios("p/m"), wallTime: 1 });
			meter.messageStart();
			for (let d = 0; d < 21; d++) {
				t = i * 10_000 + d * 100;
				meter.delta("text", "x".repeat(10));
			}
			expect(meter.snapshot()?.outputTokens).toBe(210);
			const outcome = meter.end({
				stopReason: "stop",
				provider: "p",
				model: "m",
				usage: { input: 10, output: 420, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			});
			if (outcome.kind !== "recorded") throw new Error(`expected a record, got ${outcome.kind}`);
			const sample = outcome.calibration.output;
			expect(sample).toBeDefined();
			if (sample) expect(calibration.update("p/m", "output", sample, t)).toBeUndefined();
		}
		expect(calibration.ratios("p/m")).toEqual({});
		expect(calibration.close()).toBeUndefined();
		expect(dir.accesses).toBe(0);
		expect(dir.files).toEqual(before);
	});

	it("shows no warning for a corrupt newest version while disabled (corrupt calibration while disabled)", () => {
		const dir = new WatchedDir();
		dir.files.set(version(1), "{not json");
		expect(openCalibration(false, DIR, dir).warning).toBeUndefined();
		expect(dir.accesses).toBe(0);
		expect(openCalibration(true, DIR, dir).warning).toContain("invalid JSON");
	});

	it("loads the store while enabled", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({ "p/m": { ratio: 1.5, samples: 1, updatedAt: 1 } }));
		expect(openCalibration(true, DIR, dir).calibration.ratios("p/m").output).toBe(1.5);
	});
});
