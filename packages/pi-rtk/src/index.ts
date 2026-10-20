import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatStatus, parseRtkArgs, RTK_USAGE } from "./command.ts";
import { CONFIG_FILE_NAME, loadConfig } from "./config.ts";
import { type Reporter, RtkController, STATUS_KEY } from "./controller.ts";
import { runFile } from "./run.ts";

function reporterFor(ctx: ExtensionContext): Reporter {
	return {
		notify: (message, level) => ctx.ui.notify(message, level),
		setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI): void {
	const controller = new RtkController({ run: runFile });

	pi.on("session_start", async (_event, ctx) => {
		const reporter = reporterFor(ctx);
		const { adapters, warnings } = await loadConfig(join(getAgentDir(), CONFIG_FILE_NAME));
		for (const warning of warnings) reporter.notify(warning, "warning");
		await controller.start(adapters, reporter);
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			return await controller.handleToolCall(event.toolName, event.input, ctx.cwd, ctx.signal, reporterFor(ctx));
		} catch (error) {
			// A throwing tool_call handler blocks the tool; a rewrite problem must never stop a command.
			ctx.ui.notify(`pi-rtk: command left unchanged after an internal error: ${errorMessage(error)}`, "warning");
			return undefined;
		}
	});

	pi.registerCommand("rtk", {
		description: "Show pi-rtk's state, or turn RTK rewriting on or off for this session",
		handler: async (args, ctx) => {
			const reporter = reporterFor(ctx);
			const action = parseRtkArgs(args);
			switch (action.kind) {
				case "status": {
					const registered = new Set(pi.getAllTools().map((tool) => tool.name));
					reporter.notify(formatStatus(controller, registered), "info");
					return;
				}
				case "on":
					controller.setEnabled(true, reporter);
					await controller.restart(reporter);
					if (controller.availability.ok) reporter.notify("pi-rtk: on for this session", "info");
					return;
				case "off":
					controller.setEnabled(false, reporter);
					reporter.notify("pi-rtk: off for this session", "info");
					return;
				case "usage":
					reporter.notify(RTK_USAGE, "warning");
					return;
			}
		},
	});
}
