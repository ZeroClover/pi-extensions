import type { ToolAdapter } from "./adapters.ts";
import type { RtkController } from "./controller.ts";

export const RTK_USAGE = "Usage: /rtk [on|off] (no argument shows the state)";

export type RtkAction = { kind: "status" } | { kind: "on" } | { kind: "off" } | { kind: "usage" };

export function parseRtkArgs(args: string): RtkAction {
	switch (args.trim().toLowerCase()) {
		case "":
			return { kind: "status" };
		case "on":
			return { kind: "on" };
		case "off":
			return { kind: "off" };
		default:
			return { kind: "usage" };
	}
}

/** What `/rtk on` reports after the restart; undefined when the availability check has already warned. */
export function onNotice(controller: RtkController): { message: string; level: "info" | "warning" } | undefined {
	if (!controller.availability.ok) return undefined;
	if (controller.disabledByEnv) {
		return {
			message: "pi-rtk: on for this session, but RTK_DISABLED=1 in Pi's environment keeps rewriting off",
			level: "warning",
		};
	}
	return { message: "pi-rtk: on for this session", level: "info" };
}

function describeAdapter(name: string, adapter: ToolAdapter, registered: ReadonlySet<string>): string {
	const fields = [`command: ${adapter.commandField}`];
	if (adapter.shellField !== undefined) fields.push(`shell: ${adapter.shellField}`);
	if (adapter.ttyField !== undefined) fields.push(`tty: ${adapter.ttyField}`);
	if (adapter.cwdField !== undefined) fields.push(`cwd: ${adapter.cwdField}`);
	return `${name} (${fields.join(", ")})${registered.has(name) ? "" : " [not registered]"}`;
}

/** The `/rtk` status report; `registered` holds the names of the tools registered in this session. */
export function formatStatus(controller: RtkController, registered: ReadonlySet<string>): string {
	const { availability, counts } = controller;
	let state = "on";
	if (!availability.ok) state = "unavailable";
	else if (controller.disabledByEnv) state = "off (RTK_DISABLED=1)";
	else if (controller.suspended !== undefined) state = `suspended: ${controller.suspended}`;
	else if (!controller.enabled) state = "off (/rtk off)";
	const adapters = [...controller.adapters].map(([name, adapter]) => describeAdapter(name, adapter, registered));
	const lines = [
		`state: ${state}`,
		`rtk: ${availability.ok ? availability.version : availability.reason}`,
		`tools: ${adapters.length === 0 ? "none" : adapters.join("; ")}`,
		`this session: ${counts.rewritten} rewritten, ${counts.unchanged} unchanged, ${counts.skipped} skipped, ${counts.blocked} blocked, ${counts.failed} failed`,
	];
	if (controller.lastFailure !== undefined) lines.push(`last failure: ${controller.lastFailure}`);
	return ["pi-rtk", ...lines.map((line) => `  ${line}`)].join("\n");
}
