import type { SummaryMode } from "./telemetry.ts";

export type TpsCommand = { kind: "toggle" } | { kind: "mode"; mode?: SummaryMode } | { kind: "invalid" };

export const TPS_USAGE = "Usage: /tps (toggle the readout), /tps mode (switch summary), /tps mode last|session";

/** Parses the arguments of `/tps`. */
export function parseTpsCommand(args: string): TpsCommand {
	const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const [first, second, ...rest] = words;
	if (first === undefined) return { kind: "toggle" };
	if (first !== "mode" || rest.length > 0) return { kind: "invalid" };
	if (second === undefined) return { kind: "mode" };
	if (second === "last" || second === "session") return { kind: "mode", mode: second };
	return { kind: "invalid" };
}

const COMPLETIONS = [
	{ value: "mode", label: "mode", description: "Switch the idle readout between last run and session average" },
	{ value: "mode last", label: "mode last", description: "Show the last run's summary when idle" },
	{ value: "mode session", label: "mode session", description: "Show session averages when idle" },
];

export function tpsCompletions(prefix: string): { value: string; label: string; description: string }[] | null {
	const normalized = prefix.trimStart().toLowerCase();
	const matches = COMPLETIONS.filter((item) => item.value.startsWith(normalized));
	return matches.length > 0 ? matches : null;
}
