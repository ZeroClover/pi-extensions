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
	parseCalibration,
	WRITER_RETENTION_MS,
} from "../src/calibration.ts";
import { type FileLayer, nodeFiles } from "../src/files.ts";

const DIR = "/agent/pi-tps-calibration";

function version(n: number): string {
	return join(DIR, `${String(n).padStart(10, "0")}.json`);
}

function file(models: Record<string, { ratio: number; samples: number; updatedAt: number }>): string {
	return JSON.stringify({ version: 1, models });
}

/** An in-memory directory. `beforePublish` runs once inside the next publish, before the exclusive check. */
class MemoryDir implements FileLayer {
	readonly files = new Map<string, string>();
	beforePublish: (() => void) | undefined;
	/** Runs once right after the next successful creation, before publish returns. */
	afterPublish: (() => void) | undefined;
	failPublish: Error | undefined;
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
		return true;
	}

	remove(path: string): void {
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
			seed.update("p/seed", { reported: 100, estimated: 100 }, 0);
			const paused = new CalibrationStore(dir, pausing);
			paused.load();
			const other = new CalibrationStore(dir, nodeFiles);
			other.load();
			pause = () => {
				for (let i = 0; i < 4; i++) other.update("p/b", { reported: 100 + i, estimated: 100 }, i);
			};
			paused.update("p/a", { reported: 200, estimated: 100 }, 10);
			const restored = new CalibrationStore(dir, nodeFiles);
			restored.load();
			expect(restored.entry("p/a")).toEqual({ ratio: 2, samples: 1, updatedAt: 10 });
			expect(restored.entry("p/b")?.samples).toBe(4);
			expect(restored.ratio("p/seed")).toBe(1);
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

describe("nextEntry", () => {
	it("sets the ratio directly from the first sample", () => {
		expect(nextEntry(undefined, { reported: 1000, estimated: 800 }, 1).ratio).toBe(1.25);
	});

	it("moves toward a new ratio without jumping to it", () => {
		const entry = nextEntry({ ratio: 1.25, samples: 1, updatedAt: 0 }, { reported: 1000, estimated: 1000 }, 1);
		expect(entry.ratio).toBeLessThan(1.25);
		expect(entry.ratio).toBeGreaterThan(1);
		expect(entry.samples).toBe(2);
	});

	it("converges after repeated samples", () => {
		let entry = nextEntry(undefined, { reported: 1250, estimated: 1000 }, 0);
		for (let i = 0; i < 20; i++) entry = nextEntry(entry, { reported: 1000, estimated: 1000 }, i);
		expect(entry.ratio).toBeCloseTo(1, 2);
	});

	it("clamps outliers", () => {
		expect(nextEntry(undefined, { reported: 900, estimated: 100 }, 0).ratio).toBe(4);
		expect(nextEntry(undefined, { reported: 10, estimated: 100 }, 0).ratio).toBe(0.25);
	});

	it("clamps an outlier sample before averaging it into an existing ratio", () => {
		const entry = nextEntry({ ratio: 1, samples: 3, updatedAt: 0 }, { reported: 900, estimated: 100 }, 1);
		expect(entry.ratio).toBeCloseTo(1.9);
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
				version: 1,
				models: { "a/b": { ratio: 1.1, samples: 2, updatedAt: 5 }, "c/d": { ratio: "x" } },
			}),
		);
		expect(parsed.usable).toBe(true);
		expect(parsed.models.get("a/b")?.ratio).toBe(1.1);
		expect(parsed.models.has("c/d")).toBe(false);
		expect(parsed.warning).toContain("1 invalid entry");
	});

	it("marks unparseable content unusable", () => {
		expect(parseCalibration("{not json").usable).toBe(false);
		expect(parseCalibration(JSON.stringify({ version: 2, models: {} })).usable).toBe(false);
	});
});

describe("CalibrationStore", () => {
	it("treats a missing directory as empty without warning", () => {
		const calibration = new CalibrationStore(DIR, new MemoryDir());
		expect(calibration.load()).toBeUndefined();
		expect(calibration.ratio("a/b")).toBeUndefined();
	});

	it("publishes numbered versions that a new session restores (restart)", () => {
		const dir = new MemoryDir();
		expect(store(dir).update("a/b", { reported: 1000, estimated: 800 }, 7)).toBeUndefined();
		expect(dir.files.has(version(1))).toBe(true);
		expect(store(dir).entry("a/b")).toEqual({ ratio: 1.25, samples: 1, updatedAt: 7 });
	});

	it("uses the newest valid version when the newest is corrupt, and publishes past it (corrupt file)", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({ "a/b": { ratio: 1.5, samples: 1, updatedAt: 1 } }));
		dir.files.set(version(2), "{not json");
		const calibration = new CalibrationStore(DIR, dir);
		const warning = calibration.load();
		expect(warning).toContain("invalid JSON");
		expect(warning).toContain(version(2));
		expect(calibration.ratio("a/b")).toBe(1.5);
		calibration.update("c/d", { reported: 100, estimated: 100 }, 2);
		expect(dir.files.has(version(3))).toBe(true);
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
		store(dir).update("a/b", { reported: 30, estimated: 20 }, 0);
		expect(dir.publishes).toBe(0);
	});

	it("keeps both updates when another session publishes first (concurrent sessions)", () => {
		const dir = new MemoryDir();
		const mine = store(dir);
		const other = store(dir);
		dir.beforePublish = () => other.update("x/other", { reported: 900, estimated: 600 }, 1);
		mine.update("x/mine", { reported: 1000, estimated: 800 }, 2);
		const restored = store(dir);
		expect(restored.ratio("x/other")).toBe(1.5);
		expect(restored.ratio("x/mine")).toBe(1.25);
		expect(dir.files.has(version(2))).toBe(true);
		expect(mine.ratio("x/other")).toBe(1.5);
		expect(restored.entry("x/mine")?.samples).toBe(1);
		expect(restored.entry("x/other")?.samples).toBe(1);
	});

	it("republishes a sample whose creation hit a reused version number (writer paused across several publishes)", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({}));
		const paused = store(dir);
		const other = store(dir);
		// Inside the paused session's creation of version 2, the other session publishes versions 2 to 5 and
		// removes versions 1 and 2, so the paused creation of version 2 succeeds on a reused number.
		dir.beforePublish = () => {
			for (let i = 0; i < 4; i++) other.update("p/b", { reported: 100 + i, estimated: 100 }, i);
		};
		expect(paused.update("p/a", { reported: 200, estimated: 100 }, 10)).toBeUndefined();
		const restored = store(dir);
		expect(restored.entry("p/a")).toEqual({ ratio: 2, samples: 1, updatedAt: 10 });
		expect(restored.entry("p/b")?.samples).toBe(4);
		expect(paused.flush()).toBeUndefined();
		expect(store(dir).entry("p/a")?.samples).toBe(1);
	});

	it.each([512, 513, 1025])("stores a backlog of %i samples exactly once (large backlog)", (count) => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		dir.failPublish = new Error("EIO");
		for (let i = 0; i < count; i++) {
			calibration.update("p/m", { reported: i === 0 ? 400 : 100, estimated: 100 }, i);
		}
		const expected = calibration.entry("p/m");
		expect(expected?.samples).toBe(count);
		dir.failPublish = undefined;
		expect(calibration.flush()).toBeUndefined();
		const restored = store(dir).entry("p/m");
		expect(restored).toEqual(expected);
		expect(restored?.updatedAt).toBe(count - 1);
		expect(restored?.ratio).toBeCloseTo(1, 5);
	});

	it("finds its sample stored after pausing past 512 other samples (pause after publishing)", () => {
		const dir = new MemoryDir();
		const paused = store(dir);
		const other = store(dir);
		dir.afterPublish = () => {
			for (let i = 0; i < 512; i++) other.update("p/b", { reported: 100, estimated: 100 }, i);
		};
		expect(paused.update("p/a", { reported: 200, estimated: 100 }, 1)).toBeUndefined();
		paused.flush();
		const restored = store(dir);
		expect(restored.entry("p/a")?.samples).toBe(1);
		expect(restored.entry("p/b")?.samples).toBe(512);
	});

	it("removes the records of sessions gone for more than 7 days (crashed session)", () => {
		const now = 1_000 * WRITER_RETENTION_MS;
		const dir = new MemoryDir();
		const crashed = JSON.stringify({
			version: 1,
			models: {},
			writers: { crashed: { seq: 3, at: now - WRITER_RETENTION_MS - 86_400_000 }, recent: { seq: 1, at: now - 1000 } },
		});
		dir.files.set(version(1), crashed);
		store(dir, () => now).update("p/m", { reported: 100, estimated: 100 }, 1);
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
			other.update("p/b", { reported: 100, estimated: 100 }, 2);
		};
		paused.update("p/a", { reported: 200, estimated: 100 }, 1);
		const restored = store(dir, clock);
		expect(restored.entry("p/a")?.samples).toBe(1);
		expect(restored.entry("p/b")?.samples).toBe(1);
		paused.update("p/a", { reported: 200, estimated: 100 }, 3);
		expect(store(dir, clock).entry("p/a")?.samples).toBe(2);
	});

	it("removes its own record when the session closes", () => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		calibration.update("p/m", { reported: 100, estimated: 100 }, 1);
		const newest = () => {
			const name = dir.list(DIR).sort().at(-1) ?? "";
			return JSON.parse(dir.files.get(join(DIR, name)) ?? "{}");
		};
		expect(Object.keys(newest().writers)).toHaveLength(1);
		expect(calibration.close()).toBeUndefined();
		expect(Object.keys(newest().writers)).toHaveLength(0);
		expect(newest().models["p/m"].samples).toBe(1);
	});

	it("never applies a stored sample twice when it retries", () => {
		const dir = new MemoryDir();
		const mine = store(dir);
		mine.update("p/a", { reported: 200, estimated: 100 }, 1);
		mine.flush();
		mine.update("p/a", { reported: 200, estimated: 100 }, 2);
		expect(store(dir).entry("p/a")?.samples).toBe(2);
	});

	it("applies an unpublished sample on top of another session's sample for the same model", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({ "p/m": { ratio: 1, samples: 1, updatedAt: 0 } }));
		const mine = store(dir);
		const other = store(dir);
		dir.failPublish = new Error("EIO");
		expect(mine.update("p/m", { reported: 200, estimated: 100 }, 1)).toContain("EIO");
		dir.failPublish = undefined;
		other.update("p/m", { reported: 300, estimated: 100 }, 2);
		expect(store(dir).entry("p/m")).toEqual({ ratio: 1.6, samples: 2, updatedAt: 2 });
		mine.update("q/n", { reported: 100, estimated: 100 }, 3);
		const restored = store(dir);
		expect(restored.entry("p/m")?.samples).toBe(3);
		expect(restored.ratio("p/m")).toBeCloseTo(1.72);
		expect(restored.ratio("q/n")).toBe(1);
	});

	it("publishes a queued sample at shutdown when no later update comes (no later update)", () => {
		const dir = new MemoryDir();
		const mine = store(dir);
		dir.failPublish = new Error("EIO");
		mine.update("a/b", { reported: 200, estimated: 100 }, 1);
		expect(store(dir).ratio("a/b")).toBeUndefined();
		dir.failPublish = undefined;
		expect(mine.flush()).toBeUndefined();
		expect(store(dir).ratio("a/b")).toBe(2);
	});

	it("keeps converging in memory and warns once when every write fails (unwritable file)", () => {
		const dir = new MemoryDir();
		dir.files.set(version(1), file({ "x/m": { ratio: 1, samples: 1, updatedAt: 0 } }));
		const calibration = store(dir);
		dir.failPublish = new Error("EROFS");
		const warnings: (string | undefined)[] = [];
		const ratios: number[] = [];
		for (let i = 1; i <= 3; i++) {
			warnings.push(calibration.update("x/m", { reported: 200, estimated: 100 }, i));
			ratios.push(calibration.ratio("x/m") ?? 0);
		}
		expect(warnings.filter(Boolean)).toHaveLength(1);
		expect(warnings[0]).toContain("EROFS");
		expect(ratios[0]).toBeCloseTo(1.3);
		expect(ratios[1]).toBeCloseTo(1.51);
		expect(ratios[2]).toBeCloseTo(1.657);
		expect(calibration.entry("x/m")?.samples).toBe(4);
	});

	it("keeps the sample queued when every publish attempt loses the race", () => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		dir.publish = () => false;
		expect(calibration.update("a/b", { reported: 200, estimated: 100 }, 1)).toBeUndefined();
		expect(calibration.ratio("a/b")).toBe(2);
	});

	it("keeps only the newest three versions", () => {
		const dir = new MemoryDir();
		const calibration = store(dir);
		for (let i = 1; i <= 6; i++) calibration.update("a/b", { reported: 100 + i, estimated: 100 }, i);
		expect(dir.list(DIR).sort()).toEqual(["0000000004.json", "0000000005.json", "0000000006.json"]);
	});
});
