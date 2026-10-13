import { describe, expect, it } from "vitest";
import { parseTpsCommand, tpsCompletions } from "../src/command.ts";

describe("parseTpsCommand", () => {
	it("toggles without arguments", () => {
		expect(parseTpsCommand("")).toEqual({ kind: "toggle" });
		expect(parseTpsCommand("   ")).toEqual({ kind: "toggle" });
	});

	it("toggles or sets the summary mode", () => {
		expect(parseTpsCommand("mode")).toEqual({ kind: "mode" });
		expect(parseTpsCommand("mode last")).toEqual({ kind: "mode", mode: "last" });
		expect(parseTpsCommand(" Mode  SESSION ")).toEqual({ kind: "mode", mode: "session" });
	});

	it("rejects anything else", () => {
		expect(parseTpsCommand("off")).toEqual({ kind: "invalid" });
		expect(parseTpsCommand("mode all")).toEqual({ kind: "invalid" });
		expect(parseTpsCommand("mode last now")).toEqual({ kind: "invalid" });
	});
});

describe("tpsCompletions", () => {
	it("offers mode, last and session", () => {
		expect(tpsCompletions("")?.map((item) => item.value)).toEqual(["mode", "mode last", "mode session"]);
		expect(tpsCompletions("mode s")?.map((item) => item.value)).toEqual(["mode session"]);
		expect(tpsCompletions("x")).toBeNull();
	});
});
