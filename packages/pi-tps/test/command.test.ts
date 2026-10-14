import { describe, expect, it } from "vitest";
import { parseTpsCommand, TPS_USAGE } from "../src/command.ts";

describe("parseTpsCommand", () => {
	it("toggles without arguments (hide)", () => {
		expect(parseTpsCommand("")).toEqual({ kind: "toggle" });
		expect(parseTpsCommand("   ")).toEqual({ kind: "toggle" });
	});

	it("rejects any argument (argument given)", () => {
		expect(parseTpsCommand("mode")).toEqual({ kind: "invalid" });
		expect(parseTpsCommand("mode last")).toEqual({ kind: "invalid" });
		expect(parseTpsCommand("off")).toEqual({ kind: "invalid" });
	});

	it("names the toggle in the usage", () => {
		expect(TPS_USAGE).toBe("Usage: /tps (show or hide the readout)");
	});
});
