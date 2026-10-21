import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts"],
		passWithNoTests: true,
		// End-to-end scenarios change process.env and stream with real timing: one process per file.
		pool: "forks",
		// Release scenarios that pack, install, and load in Pi raise this to 60 s for their file.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
