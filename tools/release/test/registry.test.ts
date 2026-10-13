import { describe, expect, it } from "vitest";
import { type Http, lookupVersion, tarballAvailable } from "../src/registry.ts";

function http(status: number, body = ""): Http {
	return async () => ({ status, body });
}

const metadata = JSON.stringify({
	name: "@zeroclover/pi-tps",
	versions: { "0.1.0": { dist: { tarball: "https://registry.npmjs.org/@zeroclover/pi-tps/-/pi-tps-0.1.0.tgz" } } },
});

describe("lookupVersion", () => {
	it("encodes the scoped name and finds an exact version", async () => {
		const urls: string[] = [];
		const recording: Http = async (url) => {
			urls.push(url);
			return { status: 200, body: metadata };
		};
		expect(await lookupVersion(recording, "https://registry.npmjs.org/", "@zeroclover/pi-tps", "0.1.0")).toEqual({
			kind: "found",
			tarball: "https://registry.npmjs.org/@zeroclover/pi-tps/-/pi-tps-0.1.0.tgz",
		});
		expect(urls).toEqual(["https://registry.npmjs.org/@zeroclover%2fpi-tps"]);
	});

	it("treats only a 404 or a missing version as absence", async () => {
		expect(await lookupVersion(http(404), "r", "@zeroclover/pi-tps", "0.1.0")).toEqual({ kind: "missing" });
		expect(await lookupVersion(http(200, metadata), "r", "@zeroclover/pi-tps", "0.2.0")).toEqual({ kind: "missing" });
	});

	it.each([
		["an authentication failure", http(401)],
		["a server error", http(503)],
		["invalid JSON", http(200, "<html>")],
		["metadata without versions", http(200, "{}")],
		["a transport failure", (async () => Promise.reject(new Error("ECONNRESET"))) satisfies Http],
	])("fails on %s", async (_case, transport) => {
		await expect(lookupVersion(transport, "r", "@zeroclover/pi-tps", "0.1.0")).rejects.toThrow(/registry lookup/);
	});
});

describe("tarballAvailable", () => {
	it("distinguishes served, not yet served, and failing tarballs", async () => {
		expect(await tarballAvailable(http(200), "u")).toBe(true);
		expect(await tarballAvailable(http(404), "u")).toBe(false);
		await expect(tarballAvailable(http(500), "u")).rejects.toThrow(/HTTP 500/);
	});
});
