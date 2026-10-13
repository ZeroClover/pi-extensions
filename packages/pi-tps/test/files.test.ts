import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeFiles } from "../src/files.ts";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-tps-files-"));
	path = join(dir, "data.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("nodeFiles", () => {
	it("reads a missing file as undefined and writes atomically", () => {
		expect(nodeFiles.read(path)).toBeUndefined();
		nodeFiles.write(path, "{}");
		expect(nodeFiles.read(path)).toBe("{}");
		expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
	});

	it("holds the lock exclusively until it is released", () => {
		const release = nodeFiles.lock(path);
		expect(release).toBeDefined();
		expect(nodeFiles.lock(path)).toBeUndefined();
		release?.();
		const again = nodeFiles.lock(path);
		expect(again).toBeDefined();
		again?.();
	});

	it("takes over a stale lock", () => {
		const release = nodeFiles.lock(path);
		const old = new Date(Date.now() - 10_000);
		utimesSync(`${path}.lock`, old, old);
		const takeover = nodeFiles.lock(path);
		expect(takeover).toBeDefined();
		takeover?.();
		release?.();
	});
});
