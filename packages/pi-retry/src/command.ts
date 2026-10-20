import type { GateState } from "./capture.ts";
import type { RetryController } from "./controller.ts";
import { formatRemaining } from "./format.ts";

export const RETRY_USAGE = "Usage: /retry [cancel|on|off] (no argument shows the configuration and state)";

export interface CommandResult {
	message: string;
	level: "info" | "warning";
}

function status(controller: RetryController, gate: GateState, now: number): string {
	const { config, waiting } = controller;
	const { retryable, nonRetryable } = config.patterns;
	const lines = [
		`enabled: ${controller.enabled}${controller.enabled === config.enabled ? "" : " (changed by /retry for this session)"}`,
		`maxRetries: ${config.maxRetries}`,
		`baseDelayMs: ${config.baseDelayMs}`,
		`maxBackoffMs: ${config.maxBackoffMs}`,
		`maxRetryAfterMs: ${config.maxRetryAfterMs}${config.maxRetryAfterMs === 0 ? " (no limit)" : ""}`,
		`patterns: ${retryable.length} retryable, ${nonRetryable.length} nonRetryable`,
		`headerHints: ${gate.open ? "on" : `off (${gate.reason})`}`,
		waiting
			? `state: waiting, retry ${waiting.attempt}/${config.maxRetries} in ${formatRemaining(waiting.endsAt - now)}: ${waiting.reason}`
			: "state: idle",
	];
	return ["pi-retry", ...lines.map((line) => `  ${line}`)].join("\n");
}

/** Runs `/retry` with its argument text; returns what to report, or undefined when the wait reports for itself. */
export function runRetryCommand(
	args: string,
	controller: RetryController,
	gate: GateState,
	now: number,
): CommandResult | undefined {
	switch (args.trim().toLowerCase()) {
		case "":
			return { message: status(controller, gate, now), level: "info" };
		case "cancel":
			// The waiting handler aborts the run and reports `pi-retry: retry cancelled`.
			return controller.cancel("command") ? undefined : { message: "pi-retry: no retry is waiting", level: "info" };
		case "on":
			controller.setEnabled(true);
			return { message: "pi-retry: on for this session", level: "info" };
		case "off":
			controller.setEnabled(false);
			return { message: "pi-retry: off for this session", level: "info" };
		default:
			return { message: RETRY_USAGE, level: "warning" };
	}
}
