import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Color, parseColor } from "@earendil-works/pi-tui";
import type { ColorSpec, TpsConfig } from "./config.ts";
import type { Line, Role, Segment } from "./format.ts";

/** The part of Pi's `Theme` the renderer uses. */
export interface ThemeLike {
	fg(color: ThemeColor, text: string): string;
	style(text: string, options: { fg: Color }): string;
}

/** The configured separator and colours of a line. */
export type LineStyle = Pick<TpsConfig, "separator" | "baseColor" | "separatorColor" | "burstColor">;

export function paint(theme: ThemeLike, color: ColorSpec, text: string): string {
	return color.kind === "token" ? theme.fg(color.token, text) : theme.style(text, { fg: parseColor(color.hex) });
}

function colorOf(role: Role, style: LineStyle): ColorSpec {
	switch (role) {
		case "base":
			return style.baseColor;
		case "burst":
			return style.burstColor;
		case "success":
		case "error":
			return { kind: "token", token: role };
		default:
			return role.color;
	}
}

function paintSegment(theme: ThemeLike, style: LineStyle, segment: Segment): string {
	return paint(theme, colorOf(segment.role, style), segment.text);
}

/** Produces the `setStatus` text: every segment in the colour of its role, fields joined by the separator. */
export function renderLine(line: Line, theme: ThemeLike, style: LineStyle): string {
	const fields = line.fields
		.map((field) => field.map((segment) => paintSegment(theme, style, segment)).join(""))
		.join(paint(theme, style.separatorColor, style.separator));
	if (line.marker === undefined) return fields;
	return `${paintSegment(theme, style, line.marker)} ${fields}`;
}

/** Forwards status text only when it differs from the last text written, so unchanged ticks cost no render. */
export class StatusWriter {
	private last: string | undefined;
	private written = false;

	set(text: string | undefined, write: (text: string | undefined) => void): boolean {
		if (this.written && text === this.last) return false;
		this.written = true;
		this.last = text;
		write(text);
		return true;
	}
}
