import { describe, expect, it } from "vitest";
import {
	CalibrationStore,
	calibrationKey,
	calibrationKeys,
	isCalibratable,
	nextEntry,
	parseCalibration,
} from "../src/calibration.ts";
import type { FileLayer } from "../src/files.ts";

const PATH = "/agent/pi-tps-calibration.json";

interface MemoryFiles extends FileLayer {
	content: string | undefined;
	writes: number;
	locked: boolean;
	/** Runs once inside the next write, before the content changes: lets a test interleave another session. */
	beforeWrite: (() => void) | undefined;
}

function memoryFiles(initial?: string): MemoryFiles {
	const files: MemoryFiles = {
		content: initial,
		writes: 0,
		locked: false,
		beforeWrite: undefined,
		read: () => files.content,
		write: (_path, content) => {
			const hook = files.beforeWrite;
			files.beforeWrite = undefined;
			hook?.();
			files.writes++;
			files.content = content;
		},
		lock: () => {
			if (files.locked) return undefined;
			files.locked = true;
			return () => {
				files.locked = false;
			};
		},
	};
	return files;
}

function ratioOnDisk(files: MemoryFiles, key: string): number | undefined {
	const store = new CalibrationStore(PATH, files);
	store.load();
	return store.ratio(key);
}

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
		expect(nextEntry({ ratio: 1, samples: 3, updatedAt: 0 }, { reported: 900, estimated: 100 }, 1).ratio).toBeCloseTo(
			1.9,
		);
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
		expect(parsed.models.get("a/b")?.ratio).toBe(1.1);
		expect(parsed.models.has("c/d")).toBe(false);
		expect(parsed.warning).toContain("1 invalid entry");
	});
});

describe("CalibrationStore", () => {
	it("treats a missing file as empty without warning", () => {
		const store = new CalibrationStore(PATH, memoryFiles());
		expect(store.load()).toBeUndefined();
		expect(store.ratio("a/b")).toBeUndefined();
	});

	it("starts empty with one warning on a corrupt file", () => {
		const store = new CalibrationStore(PATH, memoryFiles("{not json"));
		const warning = store.load();
		expect(warning).toContain("invalid JSON");
		expect(warning).toContain(PATH);
		expect(store.ratio("a/b")).toBeUndefined();
	});

	it("warns when the file cannot be read", () => {
		const files: FileLayer = {
			read: () => {
				throw new Error("EACCES");
			},
			write: () => {},
			lock: () => () => {},
		};
		expect(new CalibrationStore(PATH, files).load()).toContain("EACCES");
	});

	it("persists updates and restores them in a new store", () => {
		const files = memoryFiles();
		const store = new CalibrationStore(PATH, files);
		store.load();
		expect(store.update("a/b", { reported: 1000, estimated: 800 }, 7)).toBeUndefined();
		const restored = new CalibrationStore(PATH, files);
		expect(restored.load()).toBeUndefined();
		expect(restored.ratio("a/b")).toBe(1.25);
		expect(restored.entry("a/b")).toEqual({ ratio: 1.25, samples: 1, updatedAt: 7 });
	});

	it("keeps entries written by another session in the meantime", () => {
		const files = memoryFiles();
		const mine = new CalibrationStore(PATH, files);
		const other = new CalibrationStore(PATH, files);
		mine.load();
		other.load();
		other.update("x/other", { reported: 900, estimated: 600 }, 1);
		mine.update("x/mine", { reported: 1000, estimated: 800 }, 2);
		expect(ratioOnDisk(files, "x/other")).toBe(1.5);
		expect(ratioOnDisk(files, "x/mine")).toBe(1.25);
	});

	it("does not lose an update made while another session holds the file (concurrent sessions)", () => {
		const files = memoryFiles();
		const mine = new CalibrationStore(PATH, files);
		const other = new CalibrationStore(PATH, files);
		mine.load();
		other.load();
		// While mine is inside its locked read-merge-write, other tries to update a different key.
		files.beforeWrite = () => other.update("x/other", { reported: 900, estimated: 600 }, 1);
		mine.update("x/mine", { reported: 1000, estimated: 800 }, 2);
		expect(ratioOnDisk(files, "x/mine")).toBe(1.25);
		// Other kept its sample in memory and writes it with its next update.
		other.update("x/third", { reported: 600, estimated: 600 }, 3);
		expect(ratioOnDisk(files, "x/other")).toBe(1.5);
		expect(ratioOnDisk(files, "x/mine")).toBe(1.25);
		expect(ratioOnDisk(files, "x/third")).toBe(1);
	});

	it("builds on another session's ratio for the same key", () => {
		const files = memoryFiles();
		const mine = new CalibrationStore(PATH, files);
		const other = new CalibrationStore(PATH, files);
		mine.load();
		other.load();
		other.update("x/m", { reported: 200, estimated: 100 }, 1);
		mine.update("x/m", { reported: 100, estimated: 100 }, 2);
		const restored = new CalibrationStore(PATH, files);
		restored.load();
		expect(restored.entry("x/m")).toEqual({ ratio: 1.7, samples: 2, updatedAt: 2 });
	});

	it("keeps converging in memory when the file is readable but unwritable", () => {
		const files = memoryFiles(
			JSON.stringify({ version: 1, models: { "x/m": { ratio: 1, samples: 1, updatedAt: 0 } } }),
		);
		files.write = () => {
			throw new Error("EROFS");
		};
		const store = new CalibrationStore(PATH, files);
		store.load();
		const ratios: number[] = [];
		for (let i = 1; i <= 3; i++) {
			store.update("x/m", { reported: 200, estimated: 100 }, i);
			ratios.push(store.ratio("x/m") ?? 0);
		}
		expect(ratios[0]).toBeCloseTo(1.3);
		expect(ratios[1]).toBeCloseTo(1.51);
		expect(ratios[2]).toBeCloseTo(1.657);
		expect(store.entry("x/m")?.samples).toBe(4);
	});

	it("warns once when the lock cannot be created", () => {
		const files = memoryFiles();
		files.lock = () => {
			throw new Error("EACCES");
		};
		const store = new CalibrationStore(PATH, files);
		expect(store.update("x/m", { reported: 200, estimated: 100 }, 1)).toContain("EACCES");
		expect(store.update("x/m", { reported: 200, estimated: 100 }, 2)).toBeUndefined();
		expect(store.ratio("x/m")).toBeCloseTo(2);
	});

	it("ignores samples below the minimum estimate", () => {
		const files = memoryFiles();
		const store = new CalibrationStore(PATH, files);
		store.update("a/b", { reported: 30, estimated: 20 }, 0);
		expect(store.ratio("a/b")).toBeUndefined();
		expect(files.writes).toBe(0);
	});

	it("warns once when the file is unwritable and keeps calibrating in memory", () => {
		const files: FileLayer = {
			read: () => undefined,
			write: () => {
				throw new Error("EROFS");
			},
			lock: () => () => {},
		};
		const store = new CalibrationStore(PATH, files);
		expect(store.update("a/b", { reported: 1000, estimated: 800 }, 0)).toContain("EROFS");
		expect(store.update("a/b", { reported: 1000, estimated: 1000 }, 1)).toBeUndefined();
		expect(store.ratio("a/b")).toBeLessThan(1.25);
	});
});
