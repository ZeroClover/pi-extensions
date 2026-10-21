import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** A temporary directory of executables, put first on `PATH` to stand in for programs outside the repository. */
export interface TempBin {
	readonly dir: string;
	/** Writes an executable script, replacing one of the same name; returns its path. */
	write(name: string, script: string): Promise<string>;
	/** `PATH` with this directory first. */
	path(): string;
	remove(): Promise<void>;
}

export async function tempBin(): Promise<TempBin> {
	const dir = await mkdtemp(join(tmpdir(), "e2e-bin-"));
	return {
		dir,
		async write(name, script) {
			const file = join(dir, name);
			await writeFile(file, script);
			await chmod(file, 0o755);
			return file;
		},
		path: () => {
			const { PATH = "" } = process.env;
			return `${dir}${delimiter}${PATH}`;
		},
		remove: () => rm(dir, { recursive: true, force: true }),
	};
}
