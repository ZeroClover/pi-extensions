import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Synchronous file access, injected so loaders can be tested without touching the disk. */
export interface FileLayer {
	/** Returns the file content, or `undefined` when the file does not exist. Throws on any other error. */
	read(path: string): string | undefined;
	/** Replaces the file atomically. */
	write(path: string, content: string): void;
	/**
	 * Takes an exclusive cross-process lock for `path` and returns its release function, or `undefined` when another
	 * process holds it beyond the wait time. Throws when the lock cannot be created at all (for example a read-only
	 * directory).
	 */
	lock(path: string): (() => void) | undefined;
}

const LOCK_WAIT_MS = 200;
const LOCK_RETRY_MS = 5;
/** A lock older than this was left by a crashed process; the critical section takes well under a millisecond. */
const LOCK_STALE_MS = 2000;

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
	Atomics.wait(sleeper, 0, 0, ms);
}

function removeIfStale(lockPath: string): void {
	try {
		if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
	} catch (error) {
		// Released by its owner between the failed open and this check.
		if (!hasCode(error, "ENOENT")) throw error;
	}
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
	write(path, content) {
		mkdirSync(dirname(path), { recursive: true });
		// Write then rename, so a concurrent reader never sees a half-written file.
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, content, "utf8");
		renameSync(temporary, path);
	},
	lock(path) {
		const lockPath = `${path}.lock`;
		mkdirSync(dirname(path), { recursive: true });
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			try {
				closeSync(openSync(lockPath, "wx"));
				return () => {
					try {
						unlinkSync(lockPath);
					} catch (error) {
						// Taken over as stale by another process; nothing left to release.
						if (!hasCode(error, "ENOENT")) throw error;
					}
				};
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error;
			}
			removeIfStale(lockPath);
			if (Date.now() >= deadline) return undefined;
			sleep(LOCK_RETRY_MS);
		}
	},
};

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
