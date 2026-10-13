import { type Color, colorToHex } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type ColorSpec, parseConfig, type Threshold } from "../src/config.ts";
import { paint, renderSegments, StatusWriter, selectColor, type ThemeLike } from "../src/render.ts";

const theme: ThemeLike = {
	fg: (color, text) => `<${color}>${text}`,
	style: (text, options: { fg: Color }) => `<${colorToHex(options.fg)}>${text}`,
};

const DIM: ColorSpec = { kind: "token", token: "dim" };

function thresholds(list: { min: number; color: string }[]): Threshold[] {
	return parseConfig(JSON.stringify({ thresholds: list }), "test").config.thresholds;
}

const DEFAULT = thresholds([
	{ min: 0, color: "error" },
	{ min: 30, color: "warning" },
	{ min: 80, color: "success" },
]);

describe("selectColor", () => {
	it("uses the highest threshold not above the value", () => {
		expect(selectColor(DEFAULT, 45)).toEqual({ kind: "token", token: "warning" });
		expect(selectColor(DEFAULT, 80)).toEqual({ kind: "token", token: "success" });
	});

	it("selects nothing below the lowest threshold", () => {
		expect(selectColor(thresholds([{ min: 10, color: "error" }]), 4)).toBeUndefined();
	});
});

describe("renderSegments", () => {
	it("colours the TPS figure between thresholds and the rest in the base colour", () => {
		expect(renderSegments([{ text: "✓" }, { text: "Δ45.0", tps: 45 }], theme, DIM, DEFAULT)).toBe(
			"<dim>✓ <warning>Δ45.0",
		);
	});

	it("uses the base colour below the lowest threshold", () => {
		const list = thresholds([{ min: 10, color: "error" }]);
		expect(renderSegments([{ text: "Δ4.0", tps: 4 }], theme, DIM, list)).toBe("<dim>Δ4.0");
	});

	it("renders hex colours through the theme's colour mode", () => {
		const list = thresholds([{ min: 0, color: "#ff8800" }]);
		expect(renderSegments([{ text: "Δ9.0", tps: 9 }], theme, DIM, list)).toBe("<#ff8800>Δ9.0");
		expect(paint(theme, { kind: "hex", hex: "#f80" }, "x")).toBe("<#ff8800>x");
	});
});

describe("StatusWriter", () => {
	it("writes only changed text", () => {
		const written: (string | undefined)[] = [];
		const writer = new StatusWriter();
		const write = (text: string | undefined) => written.push(text);
		expect(writer.set("a", write)).toBe(true);
		expect(writer.set("a", write)).toBe(false);
		writer.set(undefined, write);
		writer.set(undefined, write);
		writer.set("b", write);
		expect(written).toEqual(["a", undefined, "b"]);
	});
});
