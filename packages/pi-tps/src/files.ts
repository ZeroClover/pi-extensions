import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Synchronous file access, injected so loaders can be tested without touching the disk. */
export interface FileLayer {
	/** Returns the file content, or `undefined` when the file does not exist. Throws on any other error. */
	read(path: string): string | undefined;
	write(path: string, content: string): void;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const nodeFiles: FileLayer = {
	read(path) {
		try {
			return readFileSync(path, "utf8");
		} catch (error) {
			if (isMissingFile(error)) return undefined;
			throw error;
		}
	},
	write(path, content) {
		mkdirSync(dirname(path), { recursive: true });
		// Write then rename, so a concurrent reader never sees a half-written file.
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, content, "utf8");
		renameSync(temporary, path);
	},
};

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
