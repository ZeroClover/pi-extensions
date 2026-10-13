import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Color, parseColor } from "@earendil-works/pi-tui";
import type { ColorSpec, LabelStyle, Threshold } from "./config.ts";
import { FIELD_SEPARATOR, type Line } from "./format.ts";

/** The part of Pi's `Theme` the renderer uses. */
export interface ThemeLike {
	fg(color: ThemeColor, text: string): string;
	style(text: string, options: { fg: Color }): string;
}

/** The colour of the highest threshold whose minimum is not greater than the value; none below the lowest. */
export function selectColor(thresholds: readonly Threshold[], value: number): ColorSpec | undefined {
	let selected: ColorSpec | undefined;
	for (const threshold of thresholds) {
		if (threshold.min <= value) selected = threshold.color;
	}
	return selected;
}

export function paint(theme: ThemeLike, color: ColorSpec, text: string): string {
	return color.kind === "token" ? theme.fg(color.token, text) : theme.style(text, { fg: parseColor(color.hex) });
}

/** Produces the `setStatus` text: the TPS field coloured by thresholds, everything else in the base colour. */
export function renderLine(
	line: Line,
	style: LabelStyle,
	theme: ThemeLike,
	baseColor: ColorSpec,
	thresholds: readonly Threshold[],
): string {
	const fields = line.segments
		.map((segment) => {
			const color = segment.tps === undefined ? baseColor : (selectColor(thresholds, segment.tps) ?? baseColor);
			return paint(theme, color, segment.text);
		})
		.join(paint(theme, baseColor, FIELD_SEPARATOR[style]));
	return line.indicator === undefined ? fields : `${paint(theme, baseColor, line.indicator)} ${fields}`;
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
