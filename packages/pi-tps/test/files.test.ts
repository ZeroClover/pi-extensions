import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeFiles } from "../src/files.ts";

let root: string;
let dir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-tps-files-"));
	dir = join(root, "store");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("nodeFiles", () => {
	it("treats a missing file and directory as absent", () => {
		expect(nodeFiles.read(join(dir, "x.json"))).toBeUndefined();
		expect(nodeFiles.list(dir)).toEqual([]);
		expect(() => nodeFiles.remove(join(dir, "x.json"))).not.toThrow();
	});

	it("publishes a file exactly once and leaves no temporary file", () => {
		const path = join(dir, "0000000001.json");
		expect(nodeFiles.publish(path, "first")).toBe(true);
		expect(nodeFiles.publish(path, "second")).toBe(false);
		expect(nodeFiles.read(path)).toBe("first");
		expect(readdirSync(dir)).toEqual(["0000000001.json"]);
	});

	it("removes a published file", () => {
		const path = join(dir, "0000000001.json");
		nodeFiles.publish(path, "x");
		nodeFiles.remove(path);
		expect(existsSync(path)).toBe(false);
	});
});
