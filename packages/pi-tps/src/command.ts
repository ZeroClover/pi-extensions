export type TpsCommand = { kind: "toggle" } | { kind: "invalid" };

export const TPS_USAGE = "Usage: /tps (show or hide the readout)";

/** Parses the arguments of `/tps`, which takes none. */
export function parseTpsCommand(args: string): TpsCommand {
	return args.trim() === "" ? { kind: "toggle" } : { kind: "invalid" };
}
