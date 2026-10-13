import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Synchronous file access, injected so stores can be tested without touching the disk. */
export interface FileLayer {
	/** Returns the file content, or `undefined` when the file does not exist. Throws on any other error. */
	read(path: string): string | undefined;
	/** Names of the entries in a directory; empty when the directory does not exist. */
	list(dir: string): string[];
	/**
	 * Creates the file with the given content atomically and only if it does not exist yet. Returns false when it
	 * exists. Readers never see a partial file, and of two concurrent publishers of one path exactly one succeeds.
	 */
	publish(path: string, content: string): boolean;
	/** Removes a file; a missing file is not an error. */
	remove(path: string): void;
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export const nodeFiles: FileLayer = {
	read(path) {
		try {
			return readFileSync(path, "utf8");
		} catch (error) {
			if (hasCode(error, "ENOENT")) return undefined;
			throw error;
		}
	},
	list(dir) {
		try {
			return readdirSync(dir);
		} catch (error) {
			if (hasCode(error, "ENOENT")) return [];
			throw error;
		}
	},
	publish(path, content) {
		mkdirSync(dirname(path), { recursive: true });
		// The content is complete before it becomes visible: hard-linking a finished temporary file is atomic and,
		// unlike rename, fails instead of replacing an existing file.
		const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
		writeFileSync(temporary, content, "utf8");
		try {
			linkSync(temporary, path);
			return true;
		} catch (error) {
			if (hasCode(error, "EEXIST")) return false;
			throw error;
		} finally {
			unlinkSync(temporary);
		}
	},
	remove(path) {
		try {
			unlinkSync(path);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
	},
};

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
