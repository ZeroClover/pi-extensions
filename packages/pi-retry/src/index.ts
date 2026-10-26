import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GateSettings } from "./capture.ts";
import { runRetryCommand } from "./command.ts";
import { CONFIG_FILE_NAME, defaultConfig, loadConfig } from "./config.ts";
import { CANCELLED_NOTICE, LAYERING_NOTICE, RECORD_TYPE, RetryController, STATUS_KEY } from "./controller.ts";

export default function (pi: ExtensionAPI): void {
	const controller = new RetryController(defaultConfig(), {
		appendRecord: (record) => pi.appendEntry(RECORD_TYPE, record),
	});

	function gateSettings(): GateSettings {
		const settings = pi.getSettings();
		return { cacheWarming: settings.cacheWarming, providerMaxRetries: settings.retry?.provider?.maxRetries };
	}

	pi.on("session_start", async (_event, ctx) => {
		const { config, warnings } = await loadConfig(join(getAgentDir(), CONFIG_FILE_NAME));
		controller.reset(config);
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
		// Unset settings read as undefined, and Pi's retry is enabled by default.
		if (pi.getSettings().retry?.enabled !== false) ctx.ui.notify(LAYERING_NOTICE, "info");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// The waiting handler's context may be stale by the time it resumes, so this handler cleans up.
		if (!controller.cancel("shutdown")) return;
		ctx.abort();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(CANCELLED_NOTICE, "info");
	});

	// Pi awaits the run before replacing the session; ending the wait here keeps the switch from waiting it out.
	pi.on("session_before_switch", () => {
		controller.cancel("switch");
	});
	pi.on("session_before_fork", () => {
		controller.cancel("switch");
	});

	pi.on("context", () => {
		controller.capture.requestStart();
	});
	pi.on("cache_warming_decision", () => {
		controller.capture.warmingDecision();
	});
	pi.on("after_provider_response", (event) => {
		controller.capture.response({ status: event.status, headers: event.headers });
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const success = controller.messageEnd(event.message, gateSettings());
		if (success) ctx.ui.notify(success, "info");
	});

	pi.on("before_agent_start", () => {
		controller.promptStart();
	});

	pi.on("agent_before_settle", (event, ctx) =>
		controller.beforeSettle(event, {
			notify: (message, level) => ctx.ui.notify(message, level),
			setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text),
			hasPendingMessages: () => ctx.hasPendingMessages(),
			abort: () => ctx.abort(),
			onTerminalInput: (handler) => ctx.ui.onTerminalInput(handler),
			gateSettings: gateSettings(),
			now: Date.now,
			random: Math.random,
		}),
	);

	pi.on("agent_settled", (event) => {
		controller.settled(event.aborted);
	});

	pi.registerCommand("retry", {
		description: "Show pi-retry's configuration and state; cancel a wait; turn retries on or off for the session",
		handler: async (args, ctx) => {
			// With a model selected the gate includes its adapter's rule, so a Bedrock session shows why headers are off.
			const api = ctx.model?.api;
			const gate = api ? controller.capture.gateFor(gateSettings(), api) : controller.gate(gateSettings());
			const result = runRetryCommand(args, controller, gate, Date.now());
			if (result) ctx.ui.notify(result.message, result.level);
		},
	});
}
